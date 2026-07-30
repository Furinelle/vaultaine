import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Duplex } from 'node:stream';
import ipaddr from 'ipaddr.js';

export function isPrivateAddress(ip: string): boolean {
    try {
        let address = ipaddr.parse(ip);
        if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
            address = address.toIPv4Address();
        }
        return address.range() !== 'unicast';
    } catch {
        return true;
    }
}

type LookupCallback = (
    error: NodeJS.ErrnoException | null,
    address?: string | Array<{ address: string; family: number }>,
    family?: number,
) => void;

function normalizedHostname(hostname: string): string {
    return hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function privateStorageEndpointHostnames(): Set<string> {
    return new Set(
        String(process.env.STORAGE_PRIVATE_HOST_ALLOWLIST || '')
            .split(',')
            .map(normalizedHostname)
            .filter(Boolean),
    );
}

function isAllowedPrivateHostname(hostname: string, allowlist: ReadonlySet<string>): boolean {
    return allowlist.has(normalizedHostname(hostname));
}

function guardedLookup(allowlist: ReadonlySet<string>) {
    return function lookup(
        hostname: string,
        options: number | { family?: number; all?: boolean },
        callback: LookupCallback,
    ): void {
    const normalizedOptions = typeof options === 'number' ? { family: options } : options || {};
    void dns.lookup(hostname, {
        all: true,
        family: normalizedOptions.family || 0,
        verbatim: true,
    }).then(addresses => {
        if (
            addresses.length === 0
            || (
                !isAllowedPrivateHostname(hostname, allowlist)
                && addresses.some(item => isPrivateAddress(item.address))
            )
        ) {
            const error = Object.assign(
                new Error('不允许连接内网、回环或保留地址'),
                { code: 'ERR_PRIVATE_NETWORK_ADDRESS' },
            );
            callback(error);
            return;
        }
        if (normalizedOptions.all) {
            callback(null, addresses);
            return;
        }
        callback(null, addresses[0].address, addresses[0].family);
    }).catch(error => callback(error as NodeJS.ErrnoException));
    };
}

function connectionHostname(options: http.ClientRequestArgs): string {
    return String(options.hostname || options.host || '').replace(/^\[|\]$/g, '');
}

class PublicOnlyHttpAgent extends http.Agent {
    constructor(private readonly privateHostnameAllowlist: ReadonlySet<string>) {
        super({ lookup: guardedLookup(privateHostnameAllowlist) as any });
    }

    override createConnection(
        options: http.ClientRequestArgs,
        callback?: (error: Error | null, stream: Duplex) => void,
    ): Duplex | null | undefined {
        const hostname = connectionHostname(options);
        if (
            net.isIP(hostname)
            && isPrivateAddress(hostname)
            && !isAllowedPrivateHostname(hostname, this.privateHostnameAllowlist)
        ) {
            const error = new Error('不允许连接内网、回环或保留地址');
            process.nextTick(() => callback?.(error, null as never));
            return undefined;
        }
        return super.createConnection(options, callback as any);
    }
}

class PublicOnlyHttpsAgent extends https.Agent {
    constructor(private readonly privateHostnameAllowlist: ReadonlySet<string>) {
        super({ lookup: guardedLookup(privateHostnameAllowlist) as any });
    }

    override createConnection(
        options: https.RequestOptions,
        callback?: (error: Error | null, stream: Duplex) => void,
    ): Duplex | null | undefined {
        const hostname = connectionHostname(options);
        if (
            net.isIP(hostname)
            && isPrivateAddress(hostname)
            && !isAllowedPrivateHostname(hostname, this.privateHostnameAllowlist)
        ) {
            const error = new Error('不允许连接内网、回环或保留地址');
            process.nextTick(() => callback?.(error, null as never));
            return undefined;
        }
        return super.createConnection(options, callback as any);
    }
}

export function createPublicOnlyHttpAgents(options: {
    allowedPrivateHostnames?: Iterable<string>;
} = {}): {
    httpAgent: http.Agent;
    httpsAgent: https.Agent;
} {
    const allowlist = new Set(
        [...(options.allowedPrivateHostnames || [])]
            .map(normalizedHostname)
            .filter(Boolean),
    );
    return {
        httpAgent: new PublicOnlyHttpAgent(allowlist),
        httpsAgent: new PublicOnlyHttpsAgent(allowlist),
    };
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('链接格式无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('仅允许 http/https 链接');
    }
    const hostname = parsed.hostname;
    if (!hostname || ['localhost', 'localhost.localdomain'].includes(hostname.toLowerCase())) {
        throw new Error('不允许访问本机地址');
    }
    const directIpVersion = net.isIP(hostname);
    const addresses = directIpVersion ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(item => isPrivateAddress(item.address))) {
        throw new Error('不允许访问内网、回环或保留地址');
    }
    return parsed;
}

export async function assertPublicHttpsUrl(rawUrl: string): Promise<URL> {
    const parsed = await assertPublicHttpUrl(rawUrl);
    if (parsed.protocol !== 'https:') {
        throw new Error('生产存储端点仅允许 https 链接');
    }
    return parsed;
}

export async function assertPublicStorageEndpoint(rawUrl: string): Promise<URL> {
    let candidate: URL;
    try {
        candidate = new URL(rawUrl);
    } catch {
        throw new Error('链接格式无效');
    }
    const privateAllowlist = privateStorageEndpointHostnames();
    const parsed = isAllowedPrivateHostname(candidate.hostname, privateAllowlist)
        ? candidate
        : await assertPublicHttpUrl(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('仅允许 http/https 链接');
    }
    if (parsed.protocol !== 'https:' && process.env.ALLOW_INSECURE_STORAGE_ENDPOINTS !== 'true') {
        throw new Error('存储端点仅允许 https；如确需 http，请显式设置 ALLOW_INSECURE_STORAGE_ENDPOINTS=true');
    }
    return parsed;
}
