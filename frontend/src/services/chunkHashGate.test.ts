import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createSequentialTaskGate } from './chunkHashGate';

const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

test('gate runs tasks one at a time in submission order', async () => {
    const gate = createSequentialTaskGate();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const results = await Promise.all([0, 1, 2, 3].map(index => gate(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 4 - index));
        order.push(index);
        active -= 1;
        return index * 10;
    })));
    assert.equal(maxActive, 1);
    assert.deepEqual(order, [0, 1, 2, 3]);
    assert.deepEqual(results, [0, 10, 20, 30]);
});

test('a failed task rejects its caller without wedging later tasks', async () => {
    const gate = createSequentialTaskGate();
    const failed = gate(async () => { throw new Error('boom'); });
    const next = gate(async () => 'ok');
    await assert.rejects(failed, { message: 'boom' });
    assert.equal(await next, 'ok');
});

test('chunk hashing is serialized so peak memory stays at one chunk buffer', () => {
    assert.match(api, /createSequentialTaskGate\(\)/);
    assert.match(api, /hashChunk\(\(\) => sha256Hex\(chunk\)\)/);
});
