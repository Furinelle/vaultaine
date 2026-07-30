import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRefreshSilentProgress } from './telegramProgressThrottle.js';

test('silent progress refreshes once per cooldown window', () => {
    assert.equal(shouldRefreshSilentProgress(undefined, 100_000), true);
    assert.equal(shouldRefreshSilentProgress(100_000, 129_999), false);
    assert.equal(shouldRefreshSilentProgress(100_000, 130_000), true);
});

test('forced control-state refresh bypasses the progress cooldown', () => {
    assert.equal(shouldRefreshSilentProgress(100_000, 100_001, true), true);
});
