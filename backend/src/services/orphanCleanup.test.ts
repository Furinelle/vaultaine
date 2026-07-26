import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupOrphanChunkDirectories, getAllFiles, isReservedTransientUploadPath } from './orphanCleanup.js';

test('orphan cleanup excludes the yt-dlp workspace while still allowing adjacent orphan cleanup', () => {
    const uploadDir = path.resolve('/srv/tg-vault/uploads');
    const ytDlpDir = path.join(uploadDir, 'ytdlp');

    assert.equal(
        isReservedTransientUploadPath(path.join(ytDlpDir, 'yd-task', 'video.part'), [ytDlpDir]),
        true,
    );
    assert.equal(
        isReservedTransientUploadPath(ytDlpDir, [ytDlpDir]),
        true,
    );
    assert.equal(
        isReservedTransientUploadPath(path.join(uploadDir, 'ytdlp-old', 'orphan.mp4'), [ytDlpDir]),
        false,
    );
    assert.equal(
        isReservedTransientUploadPath(path.join(uploadDir, 'ordinary-orphan.mp4'), [ytDlpDir]),
        false,
    );
});

test('orphan file enumeration never descends into an active yt-dlp task directory', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-vault-orphan-'));
    const ytDlpDir = path.join(root, 'ytdlp');
    const taskDir = path.join(ytDlpDir, 'yd-active');
    const ordinaryFile = path.join(root, 'ordinary-orphan.mp4');
    const activeFile = path.join(taskDir, 'active-download.part');
    await fs.promises.mkdir(taskDir, { recursive: true });
    await fs.promises.writeFile(ordinaryFile, 'ordinary');
    await fs.promises.writeFile(activeFile, 'active');

    try {
        const files = getAllFiles(root, [], [ytDlpDir]).map(file => file.path);
        assert.deepEqual(files, [ordinaryFile]);
        assert.equal(fs.existsSync(activeFile), true);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('orphan enumeration fails safe when the configured yt-dlp workspace equals the upload root', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-vault-ytdlp-root-'));
    const activeFile = path.join(root, 'yd-active', 'active-download.part');
    await fs.promises.mkdir(path.dirname(activeFile), { recursive: true });
    await fs.promises.writeFile(activeFile, 'active');

    try {
        assert.deepEqual(getAllFiles(root, [], [root]), []);
        assert.equal(fs.existsSync(activeFile), true);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('orphan chunk directory cleanup removes only stale sessionless directories', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-vault-chunk-orphan-'));
    const chunkDir = path.join(root, 'chunks');
    const uploadDir = path.join(root, 'uploads');
    const staleDir = path.join(chunkDir, 'stale-upload');
    const activeDir = path.join(chunkDir, 'active-upload');
    const freshDir = path.join(chunkDir, 'fresh-upload');
    await fs.promises.mkdir(uploadDir, { recursive: true });
    for (const dir of [staleDir, activeDir, freshDir]) {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, 'chunk_0'), 'data');
    }
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.promises.utimes(staleDir, staleTime, staleTime);
    await fs.promises.utimes(activeDir, staleTime, staleTime);

    try {
        const removed = await cleanupOrphanChunkDirectories({
            chunkDir,
            uploadDir,
            minAgeMs: 24 * 60 * 60 * 1000,
            listActiveUploadIds: async () => new Set(['active-upload']),
        });
        assert.deepEqual(removed, ['stale-upload']);
        assert.equal(fs.existsSync(staleDir), false);
        assert.equal(fs.existsSync(activeDir), true);
        assert.equal(fs.existsSync(freshDir), true);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('orphan chunk directory cleanup fails safe when the chunk dir overlaps the upload root', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-vault-chunk-overlap-'));
    const staleDir = path.join(root, 'stale-upload');
    await fs.promises.mkdir(staleDir, { recursive: true });
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.promises.utimes(staleDir, staleTime, staleTime);

    try {
        for (const uploadDir of [root, path.join(root, 'stale-upload')]) {
            const removed = await cleanupOrphanChunkDirectories({
                chunkDir: root,
                uploadDir,
                minAgeMs: 0,
                listActiveUploadIds: async () => new Set<string>(),
            });
            assert.deepEqual(removed, []);
        }
        assert.equal(fs.existsSync(staleDir), true);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('orphan chunk directory cleanup skips symlinked entries', async (t) => {
    if (process.platform === 'win32') return t.skip('symbolic-link permissions vary on Windows');
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-vault-chunk-link-'));
    const chunkDir = path.join(root, 'chunks');
    const uploadDir = path.join(root, 'uploads');
    const outsideDir = path.join(root, 'outside');
    const outsideFile = path.join(outsideDir, 'keep.bin');
    const alias = path.join(chunkDir, 'alias-upload');
    await fs.promises.mkdir(chunkDir, { recursive: true });
    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.mkdir(outsideDir, { recursive: true });
    await fs.promises.writeFile(outsideFile, 'keep');
    await fs.promises.symlink(outsideDir, alias, 'dir');
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.promises.lutimes(alias, staleTime, staleTime);

    try {
        const removed = await cleanupOrphanChunkDirectories({
            chunkDir,
            uploadDir,
            minAgeMs: 0,
            listActiveUploadIds: async () => new Set<string>(),
        });
        assert.deepEqual(removed, []);
        assert.equal(fs.existsSync(outsideFile), true);
        assert.equal(fs.existsSync(alias), true);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('orphan enumeration never follows a symlink into the reserved yt-dlp workspace', async (t) => {
    if (process.platform === 'win32') return t.skip('symbolic-link permissions vary on Windows');
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-vault-orphan-link-'));
    const ytDlpDir = path.join(root, 'ytdlp');
    const activeFile = path.join(ytDlpDir, 'yd-active', 'active-download.part');
    const alias = path.join(root, 'alias');
    await fs.promises.mkdir(path.dirname(activeFile), { recursive: true });
    await fs.promises.writeFile(activeFile, 'active');
    await fs.promises.symlink(ytDlpDir, alias, 'dir');

    try {
        assert.deepEqual(getAllFiles(root, [], [ytDlpDir]), []);
        assert.equal(fs.existsSync(activeFile), true);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
