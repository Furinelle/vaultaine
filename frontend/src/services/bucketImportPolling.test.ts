import test from 'node:test';
import assert from 'node:assert/strict';
import { pollBucketImportTask, BUCKET_IMPORT_MAX_TRANSIENT_FAILURES } from './bucketImportPolling.js';
import type { BucketImportTask } from './bucketImportApi.js';

const task = (status: BucketImportTask['status'], scanned = 0): BucketImportTask => ({
    id: 't1', status, scanned, imported: 0, skipped: 0, excluded: 0, error: status === 'failed' ? 'boom' : null,
});

const instantDelay = (delays: number[]) => (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
};

test('transient fetch failures are tolerated with increasing backoff until the task completes', async () => {
    const delays: number[] = [];
    const outcomes: Array<BucketImportTask | Error> = [
        new Error('Failed to fetch'),
        new Error('Failed to fetch'),
        task('running', 3),
        task('completed', 9),
    ];
    const progress: BucketImportTask[] = [];
    const result = await pollBucketImportTask(
        () => {
            const next = outcomes.shift()!;
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
        { delay: instantDelay(delays), pollIntervalMs: 100, onProgress: t => progress.push(t) },
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.scanned, 9);
    // 失败后间隔递增，成功一次后计数重置回基准间隔
    assert.deepEqual(delays, [100, 200, 300, 100]);
    assert.deepEqual(progress.map(t => t.status), ['running', 'completed']);
});

test('polling gives up only after consecutive transient failures reach the limit', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await assert.rejects(
        pollBucketImportTask(
            () => {
                attempts += 1;
                return Promise.reject(new Error('connection refused'));
            },
            { delay: instantDelay(delays), pollIntervalMs: 100 },
        ),
        /connection refused/,
    );
    assert.equal(attempts, BUCKET_IMPORT_MAX_TRANSIENT_FAILURES);
    assert.deepEqual(delays, [100, 200, 300, 400, 500]);
});

test('a successful poll resets the transient failure counter', async () => {
    let attempts = 0;
    // 4 次失败 → 1 次成功（重置计数）→ 再 4 次失败 → 完成：全程不应上抛
    const outcomes: Array<BucketImportTask | Error> = [
        ...Array.from({ length: 4 }, () => new Error('Failed to fetch')),
        task('running'),
        ...Array.from({ length: 4 }, () => new Error('Failed to fetch')),
        task('completed'),
    ];
    const result = await pollBucketImportTask(
        () => {
            attempts += 1;
            const next = outcomes.shift()!;
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
        { delay: () => Promise.resolve() },
    );
    assert.equal(result.status, 'completed');
    assert.equal(attempts, 10);
});

test('UNAUTHORIZED and IMPORT_TASK_LOST keep their fail-fast semantics', async () => {
    for (const sentinel of ['UNAUTHORIZED', 'IMPORT_TASK_LOST']) {
        let attempts = 0;
        await assert.rejects(
            pollBucketImportTask(
                () => {
                    attempts += 1;
                    return Promise.reject(new Error(sentinel));
                },
                { delay: () => Promise.resolve() },
            ),
            new RegExp(sentinel),
        );
        assert.equal(attempts, 1, `${sentinel} 不应参与瞬时重试`);
    }
});

test('a failed import task is returned as a terminal result, not thrown', async () => {
    const result = await pollBucketImportTask(() => Promise.resolve(task('failed')), { delay: () => Promise.resolve() });
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'boom');
});
