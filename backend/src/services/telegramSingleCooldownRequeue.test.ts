import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scheduleStorageCooldownRequeue } from './telegramUpload.js';
import { DownloadTaskQueue } from './downloadTaskQueue.js';

const source = fs.readFileSync(new URL('./telegramUpload.ts', import.meta.url), 'utf8');
const singleTaskBody = source.slice(
    source.indexOf('const singleUploadTask'),
    source.indexOf('const onSinglePendingCancelled'),
);
assert.doesNotMatch(singleTaskBody, /waitForStorageCooldownRetry/);
assert.match(singleTaskBody, /scheduleStorageCooldownRequeue\(downloadQueue, \{/);
assert.match(singleTaskBody, /onPendingCancelled: onSinglePendingCancelled/);

type FakeTimer = { handler: () => void; ms: number };

function makeFakeTimers() {
    const timers: FakeTimer[] = [];
    const setTimer = (handler: () => void, ms: number) => {
        timers.push({ handler, ms });
        return { unref: () => undefined };
    };
    return { timers, setTimer };
}

async function waitUntil(condition: () => boolean) {
    for (let i = 0; i < 100 && !condition(); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(condition());
}

async function testCooldownReleasesSlotAndAutoResumes() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const { timers, setTimer } = makeFakeTimers();
    queue.ensureGroup({ id: 'g-cool', kind: 'single', title: 'a.bin', chatId: '1' });
    queue.ensureGroup({ id: 'g-other', kind: 'single', title: 'b.bin', chatId: '1' });
    const runs: string[] = [];
    let coolRuns = 0;
    const coolTask = async () => {
        coolRuns += 1;
        if (coolRuns === 1) {
            scheduleStorageCooldownRequeue(queue, {
                groupId: 'g-cool',
                fileName: 'a.bin',
                execute: coolTask,
                cooldownUntil: new Date(Date.now() + 60_000),
            }, Date.now, setTimer);
            runs.push('cool-parked');
            return { status: 'success' as const };
        }
        runs.push('cool-retried');
        return { status: 'success' as const };
    };
    const coolPromise = queue.add('g-cool', 'a.bin', coolTask);
    const otherPromise = queue.add('g-other', 'b.bin', async () => { runs.push('other'); });
    await coolPromise;
    await otherPromise;
    assert.deepEqual(runs, ['cool-parked', 'other']);
    assert.equal(queue.getGroup('g-cool')?.state, 'paused');
    assert.equal(queue.getStats().active, 0);
    assert.equal(timers.length, 1);
    timers[0].handler();
    await waitUntil(() => runs.includes('cool-retried'));
    assert.equal(queue.getGroup('g-cool'), undefined);
    assert.equal(queue.getStats().active, 0);
    assert.equal(queue.getStats().pending, 0);
}

async function testBlockedResumeReschedules() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const { timers, setTimer } = makeFakeTimers();
    queue.ensureGroup({ id: 'g-block', kind: 'single', title: 'c.bin', chatId: '1', expectedTotal: 1 });
    let retried = false;
    scheduleStorageCooldownRequeue(queue, {
        groupId: 'g-block',
        fileName: 'c.bin',
        execute: async () => { retried = true; },
        cooldownUntil: new Date(Date.now() + 1_000),
    }, Date.now, setTimer);
    queue.pauseForDiskPressure('磁盘空间不足');
    timers[0].handler();
    assert.equal(retried, false);
    assert.equal(timers.length, 2);
    assert.equal(timers[1].ms, 30_000);
    queue.resumeFromDiskPressure();
    timers[1].handler();
    await waitUntil(() => retried);
    assert.equal(timers.length, 2);
}

async function testCancelDuringCooldownStopsRequeue() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const { timers, setTimer } = makeFakeTimers();
    queue.ensureGroup({ id: 'g-cancel', kind: 'single', title: 'd.bin', chatId: '1', expectedTotal: 1 });
    let retried = false;
    let pendingCancelled = false;
    scheduleStorageCooldownRequeue(queue, {
        groupId: 'g-cancel',
        fileName: 'd.bin',
        execute: async () => { retried = true; },
        onPendingCancelled: () => { pendingCancelled = true; },
        cooldownUntil: new Date(Date.now() + 60_000),
    }, Date.now, setTimer);
    assert.equal(queue.getGroup('g-cancel')?.state, 'paused');
    const cancelResult = queue.cancelGroup('g-cancel');
    assert.equal(cancelResult.status, 'ok');
    await waitUntil(() => pendingCancelled);
    timers[0].handler();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(retried, false);
    assert.equal(timers.length, 1);
}

await testCooldownReleasesSlotAndAutoResumes();
await testBlockedResumeReschedules();
await testCancelDuringCooldownStopsRequeue();
console.log('telegram single cooldown requeue ok');
