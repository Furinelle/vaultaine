import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { SsrfEgressProxy, resolvePublicTarget } from './ssrfEgressProxy.js';
import { YtDlpProcessError, classifyYtDlpError } from '../services/ytDlpDownload.js';

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve(address && typeof address === 'object' ? address.port : 0);
        });
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

function connectViaProxy(proxyPort: number, authority: string): Promise<{ statusLine: string; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, '127.0.0.1', () => {
            socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
        });
        socket.once('data', chunk => resolve({ statusLine: chunk.toString().split('\r\n')[0], socket }));
        socket.once('error', reject);
    });
}

function getViaProxy(proxyPort: number, absoluteUrl: string): Promise<{ status: number; statusMessage: string; body: string }> {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port: proxyPort, path: absoluteUrl }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode || 0, statusMessage: response.statusMessage || '', body }));
        });
        request.on('error', reject);
    });
}

function reservedClosedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}

test('resolvePublicTarget rejects loopback, private, link-local and localhost targets', async () => {
    for (const hostname of ['127.0.0.1', '10.0.0.8', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', 'localhost', 'localhost.localdomain']) {
        await assert.rejects(resolvePublicTarget(hostname), /不允许连接内网、回环或保留地址/, hostname);
    }
    assert.deepEqual(await resolvePublicTarget('1.1.1.1'), [{ address: '1.1.1.1', family: 4 }]);
    assert.deepEqual(await resolvePublicTarget('[2606:4700:4700::1111]'), [{ address: '2606:4700:4700::1111', family: 6 }]);
});

test('proxy rejects CONNECT tunnels to private, loopback and metadata addresses with 403', async () => {
    const proxy = new SsrfEgressProxy();
    const proxyPort = await proxy.start();
    try {
        for (const authority of ['127.0.0.1:80', '10.0.0.8:443', '169.254.169.254:80', '[::1]:443', 'localhost:443']) {
            const { statusLine, socket } = await connectViaProxy(proxyPort, authority);
            assert.match(statusLine, /^HTTP\/1\.1 403 SSRF-Blocked/, authority);
            socket.destroy();
        }
        const malformed = await connectViaProxy(proxyPort, 'no-port-authority');
        assert.match(malformed.statusLine, /^HTTP\/1\.1 400/);
        malformed.socket.destroy();
    } finally {
        await proxy.stop();
    }
});

test('proxy rejects plaintext HTTP forwards to private and metadata addresses with 403', async () => {
    const proxy = new SsrfEgressProxy();
    const proxyPort = await proxy.start();
    try {
        for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:9/x', 'http://192.168.0.1/admin']) {
            const { status, statusMessage } = await getViaProxy(proxyPort, url);
            assert.equal(status, 403, url);
            assert.equal(statusMessage, 'SSRF-Blocked', url);
        }
        const { status } = await getViaProxy(proxyPort, 'https://example.com/');
        assert.equal(status, 400);
    } finally {
        await proxy.stop();
    }
});

test('proxy forwards plaintext HTTP to the resolver-validated IP without re-resolving the hostname', async () => {
    const target = http.createServer((request, response) => {
        response.end(`ok:${request.headers.host}:${request.url}`);
    });
    const targetPort = await listen(target);
    const proxy = new SsrfEgressProxy(async hostname => {
        assert.equal(hostname, 'public.test');
        return [{ address: '127.0.0.1', family: 4 }];
    });
    const proxyPort = await proxy.start();
    try {
        const { status, body } = await getViaProxy(proxyPort, `http://public.test:${targetPort}/hello?a=1`);
        assert.equal(status, 200);
        assert.equal(body, `ok:public.test:${targetPort}:/hello?a=1`);
    } finally {
        await proxy.stop();
        await close(target);
    }
});

test('proxy establishes CONNECT tunnels to the resolver-validated IP and pipes both directions', async () => {
    const target = http.createServer((request, response) => {
        response.end(`tunnel:${request.url}`);
    });
    const targetPort = await listen(target);
    const proxy = new SsrfEgressProxy(async () => [{ address: '127.0.0.1', family: 4 }]);
    const proxyPort = await proxy.start();
    try {
        const { statusLine, socket } = await connectViaProxy(proxyPort, `public.test:${targetPort}`);
        assert.match(statusLine, /^HTTP\/1\.1 200/);
        const body = await new Promise<string>((resolve, reject) => {
            let buffer = '';
            socket.on('data', chunk => {
                buffer += chunk.toString();
                if (buffer.includes('tunnel:/inner')) resolve(buffer);
            });
            socket.once('error', reject);
            socket.write(`GET /inner HTTP/1.1\r\nHost: public.test:${targetPort}\r\nConnection: close\r\n\r\n`);
        });
        assert.match(body, /tunnel:\/inner/);
        socket.destroy();
    } finally {
        await proxy.stop();
        await close(target);
    }
});

test('proxy falls back to the next resolved address when the first is unreachable', async () => {
    const target = http.createServer((request, response) => {
        response.end(`ok:${request.url}`);
    });
    const targetPort = await listen(target);
    const proxy = new SsrfEgressProxy(async () => [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
    ]);
    const proxyPort = await proxy.start();
    try {
        const { status, body } = await getViaProxy(proxyPort, `http://public.test:${targetPort}/fallback`);
        assert.equal(status, 200);
        assert.equal(body, 'ok:/fallback');
        const { statusLine, socket } = await connectViaProxy(proxyPort, `public.test:${targetPort}`);
        assert.match(statusLine, /^HTTP\/1\.1 200/);
        socket.destroy();
    } finally {
        await proxy.stop();
        await close(target);
    }
});

test('proxy answers 502 when every resolved address is unreachable', async () => {
    const closedPort = await reservedClosedPort();
    const proxy = new SsrfEgressProxy(async () => [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
    ]);
    const proxyPort = await proxy.start();
    try {
        const { status } = await getViaProxy(proxyPort, `http://public.test:${closedPort}/x`);
        assert.equal(status, 502);
        const { statusLine, socket } = await connectViaProxy(proxyPort, `public.test:${closedPort}`);
        assert.match(statusLine, /^HTTP\/1\.1 502/);
        socket.destroy();
    } finally {
        await proxy.stop();
    }
});

test('track never registers duplicate close listeners for the same socket', () => {
    const proxy = new SsrfEgressProxy();
    const socket = new net.Socket();
    const track = (proxy as unknown as { track(target: net.Socket): void }).track.bind(proxy);
    track(socket);
    track(socket);
    assert.equal(socket.listenerCount('close'), 1);
    socket.destroy();
});

test('classifyYtDlpError keeps friendly categories and never echoes unrecognized stderr', () => {
    assert.match(classifyYtDlpError(new YtDlpProcessError('ERROR: Unsupported URL: https://example.com')), /yt-dlp 支持/);
    assert.match(classifyYtDlpError(new YtDlpProcessError('Tunnel connection failed: 403 Forbidden')), /出站安全策略拦截/);
    assert.match(classifyYtDlpError(new YtDlpProcessError('Tunnel connection failed: 403 SSRF-Blocked')), /出站安全策略拦截/);
    assert.match(classifyYtDlpError(new YtDlpProcessError('HTTP Error 403: SSRF-Blocked')), /出站安全策略拦截/);
    assert.match(classifyYtDlpError(new YtDlpProcessError('ProxyError: Tunnel connection failed: 502 Bad Gateway')), /暂时不可用/);
    assert.match(classifyYtDlpError(new YtDlpProcessError('urlopen error timed out')), /暂时不可用/);
    assert.match(classifyYtDlpError(new YtDlpProcessError('ERROR: Postprocessing: ffmpeg exited with code 1')), /转码或合并失败/);
    const leaked = 'Traceback (most recent call last): File "/opt/app/secret/path.py" token=abc123SECRET';
    const message = classifyYtDlpError(new YtDlpProcessError(leaked));
    assert.ok(!message.includes('abc123SECRET'));
    assert.ok(!message.includes('/opt/app/secret/path.py'));
    assert.match(message, /服务器日志/);
});

test('classifyYtDlpError passes through application-side diagnostics untouched', () => {
    for (const diagnostic of ['下载完成但未找到可上传的输出文件', '任务缺少存储目标快照', '任务记录不存在']) {
        assert.equal(classifyYtDlpError(new Error(diagnostic)), diagnostic);
    }
    assert.match(classifyYtDlpError(new Error('')), /服务器日志/);
});

test('yt-dlp spawn is forced through the local SSRF egress proxy', () => {
    const source = fs.readFileSync(new URL('../services/ytDlpDownload.ts', import.meta.url), 'utf8');
    assert.match(source, /const proxyPort = await ensureSharedSsrfEgressProxy\(\);/);
    assert.match(source, /'--proxy', `http:\/\/127\.0\.0\.1:\$\{proxyPort\}`/);
});
