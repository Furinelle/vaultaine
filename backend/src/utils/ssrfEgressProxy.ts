import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { isPrivateAddress } from './networkSecurity.js';

export interface SsrfProxyTarget {
    address: string;
    family: number;
}

export type SsrfTargetResolver = (hostname: string) => Promise<SsrfProxyTarget[]>;

function privateNetworkError(): Error {
    return Object.assign(
        new Error('不允许连接内网、回环或保留地址'),
        { code: 'ERR_PRIVATE_NETWORK_ADDRESS' },
    );
}

function isPolicyRejection(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === 'ERR_PRIVATE_NETWORK_ADDRESS';
}

export async function resolvePublicTarget(hostname: string): Promise<SsrfProxyTarget[]> {
    const bare = hostname.replace(/^\[|\]$/g, '');
    if (!bare || ['localhost', 'localhost.localdomain'].includes(bare.toLowerCase())) {
        throw privateNetworkError();
    }
    const directFamily = net.isIP(bare);
    if (directFamily) {
        if (isPrivateAddress(bare)) throw privateNetworkError();
        return [{ address: bare, family: directFamily }];
    }
    const addresses = await dns.lookup(bare, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(item => isPrivateAddress(item.address))) {
        throw privateNetworkError();
    }
    return addresses.map(item => ({ address: item.address, family: item.family }));
}

function parseConnectAuthority(authority: string): { hostname: string; port: number } | null {
    const match = authority.match(/^\[([^\]]+)\]:(\d+)$/) || authority.match(/^([^:[\]]+):(\d+)$/);
    if (!match) return null;
    const port = Number(match[2]);
    if (!match[1] || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { hostname: match[1], port };
}

export class SsrfEgressProxy {
    private server: http.Server | null = null;
    private readonly sockets = new Set<Duplex>();

    constructor(private readonly resolveTarget: SsrfTargetResolver = resolvePublicTarget) {}

    get port(): number {
        const address = this.server?.address();
        return address && typeof address === 'object' ? address.port : 0;
    }

    async start(): Promise<number> {
        if (this.server) return this.port;
        const server = http.createServer((request, response) => this.handleRequest(request, response));
        server.on('connect', (request, clientSocket, head) => this.handleConnect(request, clientSocket, head));
        server.on('connection', socket => this.track(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                server.on('error', error => console.error('[ssrf-proxy] server error:', error));
                resolve();
            });
        });
        server.unref();
        return this.port;
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (!server) return;
        this.server = null;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    private track(socket: Duplex): void {
        if (this.sockets.has(socket)) return;
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
    }

    private async connectUpstream(targets: SsrfProxyTarget[], port: number): Promise<net.Socket> {
        let lastError: Error = new Error('no reachable address');
        for (const target of targets) {
            try {
                return await new Promise<net.Socket>((resolve, reject) => {
                    const socket = net.connect({ host: target.address, family: target.family, port });
                    socket.once('error', reject);
                    socket.once('connect', () => {
                        socket.removeListener('error', reject);
                        resolve(socket);
                    });
                });
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }
        throw lastError;
    }

    private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
        let parsed: URL;
        try {
            parsed = new URL(request.url || '');
        } catch {
            response.writeHead(400).end();
            return;
        }
        if (parsed.protocol !== 'http:') {
            response.writeHead(400).end();
            return;
        }
        request.on('error', () => response.destroy());
        void this.resolveTarget(parsed.hostname).then(async targets => {
            const socket = await this.connectUpstream(targets, parsed.port ? Number(parsed.port) : 80);
            if (response.destroyed) {
                socket.destroy();
                return;
            }
            this.track(socket);
            const headers = { ...request.headers };
            delete headers['proxy-connection'];
            headers.host = parsed.host;
            const upstream = http.request({
                createConnection: () => socket,
                method: request.method,
                path: `${parsed.pathname}${parsed.search}`,
                headers,
                setHost: false,
            }, upstreamResponse => {
                response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
                upstreamResponse.pipe(response);
            });
            upstream.on('error', () => {
                if (!response.headersSent) response.writeHead(502);
                response.end();
            });
            response.on('close', () => upstream.destroy());
            request.pipe(upstream);
        }).catch(error => {
            if (isPolicyRejection(error)) response.writeHead(403, 'SSRF-Blocked').end();
            else response.writeHead(502).end();
        });
    }

    private handleConnect(request: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
        clientSocket.on('error', () => clientSocket.destroy());
        const authority = parseConnectAuthority(request.url || '');
        if (!authority) {
            clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        void this.resolveTarget(authority.hostname).then(async targets => {
            const upstream = await this.connectUpstream(targets, authority.port);
            if (clientSocket.destroyed) {
                upstream.destroy();
                return;
            }
            this.track(upstream);
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
            upstream.on('error', () => clientSocket.destroy());
            clientSocket.on('close', () => upstream.destroy());
        }).catch(error => {
            clientSocket.end(`HTTP/1.1 ${isPolicyRejection(error) ? '403 SSRF-Blocked' : '502 Bad Gateway'}\r\n\r\n`);
        });
    }
}

let sharedProxy: SsrfEgressProxy | null = null;
let sharedStartup: Promise<number> | null = null;

export function ensureSharedSsrfEgressProxy(): Promise<number> {
    if (!sharedStartup) {
        const proxy = new SsrfEgressProxy();
        sharedProxy = proxy;
        sharedStartup = proxy.start().catch(error => {
            if (sharedProxy === proxy) {
                sharedProxy = null;
                sharedStartup = null;
            }
            throw error;
        });
    }
    return sharedStartup;
}

export async function stopSharedSsrfEgressProxy(): Promise<void> {
    const proxy = sharedProxy;
    sharedProxy = null;
    sharedStartup = null;
    await proxy?.stop();
}
