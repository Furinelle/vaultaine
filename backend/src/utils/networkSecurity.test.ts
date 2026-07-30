import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { assertPublicStorageEndpoint, createPublicOnlyHttpAgents, isPrivateAddress } from './networkSecurity.js';

test('storage endpoint guard rejects mapped, reserved and multicast addresses', () => {
    for (const address of [
        '::ffff:127.0.0.1',
        '::ffff:169.254.169.254',
        '::127.0.0.1',
        'ff02::1',
        '192.0.2.1',
        '198.51.100.1',
        '203.0.113.1',
        '100.64.0.1',
    ]) {
        assert.equal(isPrivateAddress(address), true, address);
    }
    assert.equal(isPrivateAddress('1.1.1.1'), false);
    assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('connection-time HTTP guard blocks a direct private redirect target before connecting', async () => {
    const { httpAgent } = createPublicOnlyHttpAgents();
    await assert.rejects(
        new Promise<void>((resolve, reject) => {
            const request = http.get('http://127.0.0.1:9/', { agent: httpAgent }, response => {
                response.resume();
                resolve();
            });
            request.on('error', reject);
        }),
        /不允许连接内网/,
    );
    httpAgent.destroy();
});

test('an explicit storage-only hostname allowlist permits only that private endpoint', async () => {
    const server = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const { httpAgent } = createPublicOnlyHttpAgents({ allowedPrivateHostnames: ['127.0.0.1'] });
    try {
        const body = await new Promise<string>((resolve, reject) => {
            const request = http.get(`http://127.0.0.1:${address.port}/`, { agent: httpAgent }, response => {
                let value = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { value += chunk; });
                response.on('end', () => resolve(value));
            });
            request.on('error', reject);
        });
        assert.equal(body, 'ok');
    } finally {
        httpAgent.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test('storage URL validation requires an exact private hostname allowlist and explicit HTTP opt-in', async () => {
    const previousAllowlist = process.env.STORAGE_PRIVATE_HOST_ALLOWLIST;
    const previousInsecure = process.env.ALLOW_INSECURE_STORAGE_ENDPOINTS;
    process.env.STORAGE_PRIVATE_HOST_ALLOWLIST = 'cloudreve';
    process.env.ALLOW_INSECURE_STORAGE_ENDPOINTS = 'true';
    try {
        assert.equal((await assertPublicStorageEndpoint('http://cloudreve:5212/dav')).hostname, 'cloudreve');
        await assert.rejects(assertPublicStorageEndpoint('http://localhost:5212/dav'), /不允许访问本机地址/);
    } finally {
        if (previousAllowlist === undefined) delete process.env.STORAGE_PRIVATE_HOST_ALLOWLIST;
        else process.env.STORAGE_PRIVATE_HOST_ALLOWLIST = previousAllowlist;
        if (previousInsecure === undefined) delete process.env.ALLOW_INSECURE_STORAGE_ENDPOINTS;
        else process.env.ALLOW_INSECURE_STORAGE_ENDPOINTS = previousInsecure;
    }
});
