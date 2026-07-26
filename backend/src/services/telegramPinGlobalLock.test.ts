import assert from 'node:assert/strict';
import fs from 'node:fs';
import { advancePinFailureState, type PinFailureState } from './telegramBot.js';

const windowMs = 900_000;
const lockMs = 600_000;

let state: PinFailureState | null = null;
for (let attempt = 1; attempt <= 19; attempt += 1) {
    state = advancePinFailureState(state, 1_000 + attempt, windowMs, 20, lockMs);
    assert.equal(state.failed, attempt);
    assert.equal(state.lockedUntil, undefined);
}
state = advancePinFailureState(state, 2_000, windowMs, 20, lockMs);
assert.equal(state.failed, 20);
assert.equal(state.lockedUntil, 2_000 + lockMs);

const expired = advancePinFailureState({ windowStartedAt: 0, failed: 19 }, windowMs, windowMs, 20, lockMs);
assert.equal(expired.failed, 1);
assert.equal(expired.lockedUntil, undefined);

const source = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
assert.match(source, /TELEGRAM_PIN_GLOBAL_FAIL_MAX/);
assert.match(source, /TELEGRAM_PIN_GLOBAL_LOCK_MS/);
assert.match(source, /Math\.max\(getPinLockSeconds\(userId\), getGlobalPinLockSeconds\(\)\)/);
assert.match(source, /globalPinFailureState = advancePinFailureState\(globalPinFailureState, now, TELEGRAM_PIN_FAIL_WINDOW_MS, TELEGRAM_PIN_GLOBAL_FAIL_MAX, TELEGRAM_PIN_GLOBAL_LOCK_MS\)/);

const envExample = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
const compose = fs.readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
for (const contents of [envExample, compose]) {
    assert.match(contents, /TELEGRAM_AUTO_ALLOW_FIRST_USER/);
    assert.match(contents, /TELEGRAM_PIN_GLOBAL_FAIL_MAX/);
    assert.match(contents, /TELEGRAM_PIN_GLOBAL_LOCK_MS/);
}
assert.match(envExample, /TELEGRAM_AUTO_ALLOW_FIRST_USER=false/);
assert.match(compose, /TELEGRAM_AUTO_ALLOW_FIRST_USER=\$\{TELEGRAM_AUTO_ALLOW_FIRST_USER:-false\}/);

console.log('telegram pin global lock ok');
