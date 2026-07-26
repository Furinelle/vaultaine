import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
    getBucketImportTask,
    normalizeBucketObjectForImport,
    runBucketImport,
    startBucketImportTask,
    type BucketImportPage,
    type BucketImportProgress,
} from './bucketImport.js';

const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const storageRoute = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');

test('bucket object identity is enforced by PostgreSQL and inserts are conflict-safe', () => {
    assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_files_account_path_unique[\s\S]*storage_account_id,\s*path/);
    assert.match(storageRoute, /ON CONFLICT \(storage_account_id, path\)[\s\S]*DO NOTHING/);
});

test('bucket import rejects keys that cannot be represented safely in the files schema', () => {
    assert.equal(normalizeBucketObjectForImport({ key: '_backups/db.dump', size: 1 }), null);
    assert.equal(normalizeBucketObjectForImport({ key: 'folder/', size: 0 }), null);
    assert.equal(normalizeBucketObjectForImport({ key: `folder/${'x'.repeat(256)}`, size: 1 }), null);
    assert.equal(normalizeBucketObjectForImport({ key: `${'x'.repeat(256)}/file.txt`, size: 1 }), null);
    assert.equal(normalizeBucketObjectForImport({ key: 'bad/../file.txt', size: 1 }), null);
    assert.deepEqual(
        normalizeBucketObjectForImport({ key: 'photos/2026/image.jpg', size: 42 }),
        {
            name: 'image.jpg',
            storedName: 'image.jpg',
            path: 'photos/2026/image.jpg',
            folder: 'photos/2026',
            size: 42,
        },
    );
});

test('bucket import consumes one bounded page at a time and remains retry-safe', async () => {
    const pages = new Map<string | undefined, BucketImportPage>([
        [undefined, {
            objects: [
                { key: 'a.txt', size: 1 },
                { key: '_backups/db.dump', size: 2 },
            ],
            nextContinuationToken: 'next',
        }],
        ['next', {
            objects: [
                { key: 'folder/b.txt', size: 3 },
                { key: `${'x'.repeat(256)}.txt`, size: 4 },
            ],
        }],
    ]);
    const batches: string[][] = [];

    const result = await runBucketImport({
        listPage: async token => pages.get(token)!,
        insertBatch: async records => {
            batches.push(records.map(record => record.path));
            return records.filter(record => record.path !== 'a.txt').length;
        },
    });

    assert.deepEqual(batches, [['a.txt'], ['folder/b.txt']]);
    assert.deepEqual(result, {
        scanned: 4,
        imported: 1,
        skipped: 1,
        excluded: 2,
    });
});

test('bucket import skips objects still awaiting pending write reconciliation', () => {
    for (const table of ['chunk_upload_reconciliations', 'telegram_write_reconciliations', 'ytdlp_write_reconciliations']) {
        assert.match(storageRoute, new RegExp(
            `NOT EXISTS \\(\\s*SELECT 1 FROM ${table} r\\s*` +
            `WHERE r\\.status = 'pending' AND r\\.account_id = \\$1 AND r\\.stored_path = item\\.path`,
        ));
    }
});

test('bucket import runs as a background task with a pollable status endpoint', () => {
    assert.match(storageRoute, /startBucketImportTask\(/);
    assert.match(storageRoute, /res\.status\(202\)\.json\(\{ success: true, taskId: task\.id \}\)/);
    assert.match(storageRoute, /router\.get\('\/import-from-bucket\/tasks\/:taskId'/);
    assert.match(storageRoute, /IMPORT_TASK_NOT_FOUND/);
    assert.doesNotMatch(storageRoute, /const result = await runBucketImport/);
});

test('runBucketImport reports cumulative progress after each page', async () => {
    const pages = new Map<string | undefined, BucketImportPage>([
        [undefined, { objects: [{ key: 'a.txt', size: 1 }, { key: '_backups/db.dump', size: 2 }], nextContinuationToken: 'next' }],
        ['next', { objects: [{ key: 'folder/b.txt', size: 3 }] }],
    ]);
    const events: BucketImportProgress[] = [];

    const result = await runBucketImport({
        listPage: async token => pages.get(token)!,
        insertBatch: async records => records.length,
        onProgress: progress => events.push(progress),
    });

    assert.deepEqual(events, [
        { scanned: 2, imported: 1, skipped: 0, excluded: 1 },
        { scanned: 3, imported: 2, skipped: 0, excluded: 1 },
    ]);
    assert.deepEqual(result, { scanned: 3, imported: 2, skipped: 0, excluded: 1 });
});

test('bucket import task exposes live progress and settles once on completion', async () => {
    let release!: (value: BucketImportProgress) => void;
    const gate = new Promise<BucketImportProgress>(resolve => { release = resolve; });
    let reportProgress!: (progress: BucketImportProgress) => void;
    let settled = 0;

    const task = startBucketImportTask({
        accountId: 'account-1',
        run: onProgress => { reportProgress = onProgress; return gate; },
        onSettled: () => { settled += 1; },
    });
    assert.equal(task.status, 'running');

    reportProgress({ scanned: 3, imported: 1, skipped: 1, excluded: 1 });
    const running = getBucketImportTask(task.id)!;
    assert.equal(running.status, 'running');
    assert.equal(running.scanned, 3);
    assert.equal(running.imported, 1);
    assert.equal(running.finishedAt, null);

    release({ scanned: 5, imported: 2, skipped: 2, excluded: 1 });
    await new Promise(resolve => setImmediate(resolve));
    const finished = getBucketImportTask(task.id)!;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.scanned, 5);
    assert.equal(finished.imported, 2);
    assert.equal(finished.error, null);
    assert.ok(finished.finishedAt);
    assert.equal(settled, 1);
});

test('bucket import task records the failure reason and still settles', async () => {
    let settled = 0;
    const task = startBucketImportTask({
        accountId: 'account-2',
        run: async () => { throw new Error('列举失败'); },
        onSettled: () => { settled += 1; },
    });

    await new Promise(resolve => setImmediate(resolve));
    const finished = getBucketImportTask(task.id)!;
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, '列举失败');
    assert.ok(finished.finishedAt);
    assert.equal(settled, 1);
    assert.equal(getBucketImportTask('missing-task'), null);
});
