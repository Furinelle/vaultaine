import assert from 'node:assert/strict';
import {
    isTelegramAutoAllowFirstUserEnabled,
    parseTelegramAllowedUserIds,
    serializeTelegramAllowedUserIds,
    shouldAutoAllowFirstTelegramUser,
} from './authSettings.js';

assert.deepEqual(parseTelegramAllowedUserIds('123, 456\n789'), [123, 456, 789]);
assert.deepEqual(parseTelegramAllowedUserIds('123,abc,0,-1,123'), [123]);
assert.equal(serializeTelegramAllowedUserIds([456, 123, 456]), '123,456');

assert.equal(isTelegramAutoAllowFirstUserEnabled(undefined), false);
assert.equal(isTelegramAutoAllowFirstUserEnabled(''), false);
assert.equal(isTelegramAutoAllowFirstUserEnabled('false'), false);
assert.equal(isTelegramAutoAllowFirstUserEnabled('1'), false);
assert.equal(isTelegramAutoAllowFirstUserEnabled('true'), true);
assert.equal(isTelegramAutoAllowFirstUserEnabled(' true '), true);

assert.equal(shouldAutoAllowFirstTelegramUser([], 0, true), true);
assert.equal(shouldAutoAllowFirstTelegramUser([123], 0, true), false);
assert.equal(shouldAutoAllowFirstTelegramUser([], 1, true), false);
assert.equal(shouldAutoAllowFirstTelegramUser([], 0, false), false);

delete process.env.TELEGRAM_AUTO_ALLOW_FIRST_USER;
assert.equal(shouldAutoAllowFirstTelegramUser([], 0), false);
process.env.TELEGRAM_AUTO_ALLOW_FIRST_USER = 'true';
assert.equal(shouldAutoAllowFirstTelegramUser([], 0), true);
delete process.env.TELEGRAM_AUTO_ALLOW_FIRST_USER;

console.log('telegram allowed users helpers ok');
