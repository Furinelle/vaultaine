import assert from 'node:assert/strict';
import test from 'node:test';
import { PersistentYtDlpQueue } from './ytDlpDownload.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test('retry committed while the old worker is active is enqueued after old generation cleanup', async () => {
    const firstGate = deferred();
    const secondDone = deferred();
    let attempts = 0;
    let durablePending = false;
    const queue = new PersistentYtDlpQueue(1, async () => {
        attempts += 1;
        if (attempts === 1) await firstGate.promise;
        else secondDone.resolve();
    }, async () => durablePending && attempts < 2);

    queue.enqueue('yd-race');
    await new Promise(resolve => setTimeout(resolve, 0));
    durablePending = true;
    queue.enqueue('yd-race');
    firstGate.resolve();

    await Promise.race([
        secondDone.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('retried generation was stranded')), 1000)),
    ]);
    assert.equal(attempts, 2);
});

test('worker rejection is contained without unhandled rejection and scheduling continues', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
        const secondDone = deferred();
        const ran: string[] = [];
        const queue = new PersistentYtDlpQueue(1, async id => {
            ran.push(id);
            if (id === 'yd-crash') throw new Error('claim failed');
            secondDone.resolve();
        }, async () => false);

        queue.enqueue('yd-crash');
        queue.enqueue('yd-next');
        await Promise.race([
            secondDone.promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('queue stalled after worker rejection')), 1000)),
        ]);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(ran, ['yd-crash', 'yd-next']);
        assert.equal(unhandled.length, 0);
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
    }
});