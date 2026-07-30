import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { WebDAVStorageProvider } from './storage.js';

test('WebDAV read stream is aborted when the remote stops sending data', async () => {
    const provider = new WebDAVStorageProvider('account-1', 'http://127.0.0.1:9', undefined, undefined, 20);
    let signal: AbortSignal | undefined;
    (provider as any).client = {
        createReadStream: (_remotePath: string, options?: { signal?: AbortSignal }) => {
            signal = options?.signal;
            const stream = new PassThrough();
            options?.signal?.addEventListener('abort', () => stream.destroy(options.signal?.reason || new Error('aborted')), { once: true });
            return stream;
        },
    };

    const stream = await provider.getFileStream('remote/object');
    const error = await new Promise<Error>(resolve => stream.once('error', resolve));
    assert.match(error.message, /WebDAV download timed out after 20ms/);
    assert.equal(signal?.aborted, true);
});

test('slow WebDAV upload is governed by a whole-request deadline, not local read-ahead', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-vault-webdav-progress-'));
    const input = path.join(dir, 'payload.bin');
    await writeFile(input, Buffer.alloc(32));
    const provider = new WebDAVStorageProvider('account-1', 'http://127.0.0.1:9', undefined, undefined, 25, 100);
    (provider as any).client = {
        putFileContents: async (_remotePath: string, _stream: NodeJS.ReadableStream, options?: { signal?: AbortSignal }) => {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, 65);
                options?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(options.signal?.reason || new Error('aborted'));
                }, { once: true });
            });
        },
    };

    try {
        assert.equal(await provider.saveFile(input, 'payload.bin', 'application/octet-stream'), 'payload.bin');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('WebDAV streamed uploads send the authoritative content length and MIME type', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-vault-webdav-length-'));
    const input = path.join(dir, 'payload.mp4');
    await writeFile(input, Buffer.alloc(37));
    const provider = new WebDAVStorageProvider('account-1', 'http://127.0.0.1:9');
    let receivedOptions: { headers?: Record<string, string> } | undefined;
    (provider as any).client = {
        putFileContents: async (_remotePath: string, _stream: NodeJS.ReadableStream, options?: { headers?: Record<string, string> }) => {
            receivedOptions = options;
        },
    };

    try {
        await provider.saveFile(input, 'payload.mp4', 'video/mp4');
        assert.deepEqual(receivedOptions?.headers, {
            'Content-Length': '37',
            'Content-Type': 'video/mp4',
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('WebDAV metadata request aborts when the remote stops responding', async () => {
    const provider = new WebDAVStorageProvider('account-1', 'http://127.0.0.1:9', undefined, undefined, 20);
    (provider as any).client = {
        stat: async (_remotePath: string, options?: { signal?: AbortSignal }) => {
            await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason || new Error('aborted')), { once: true });
            });
        },
    };

    await assert.rejects(() => provider.getFileSize('remote/object'), /WebDAV stat timed out after 20ms/);
});

test('WebDAV delete aborts a stalled request instead of hanging the API forever', async () => {
    const provider = new WebDAVStorageProvider('account-1', 'http://127.0.0.1:9', undefined, undefined, 20);
    (provider as any).client = {
        deleteFile: async (_remotePath: string, options?: { signal?: AbortSignal }) => {
            await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason || new Error('aborted')), { once: true });
            });
        },
    };

    await assert.rejects(() => provider.deleteFile('remote/object'), /WebDAV delete timed out after 20ms/);
});

test('WebDAV upload aborts a stalled request after the configured inactivity timeout', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-vault-webdav-timeout-'));
    const input = path.join(dir, 'payload.bin');
    await writeFile(input, Buffer.alloc(32));
    const provider = new WebDAVStorageProvider('account-1', 'http://127.0.0.1:9', undefined, undefined, 20, 20);
    let receivedSignal: AbortSignal | undefined;
    (provider as any).client = {
        putFileContents: async (_remotePath: string, _stream: NodeJS.ReadableStream, options?: { signal?: AbortSignal }) => {
            receivedSignal = options?.signal;
            await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason || new Error('aborted')), { once: true });
            });
        },
    };

    try {
        await assert.rejects(
            () => provider.saveFile(input, 'payload.bin', 'application/octet-stream'),
            /WebDAV upload timed out after 20ms/,
        );
        assert.ok(receivedSignal, 'WebDAV request must receive an AbortSignal');
        assert.equal(receivedSignal?.aborted, true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
