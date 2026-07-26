import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { ensureOkResponse, throwIfUnauthorized, UNAUTHORIZED_MESSAGE } from './apiResponseContract';

const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('401 and 428 both map to the shared UNAUTHORIZED sentinel by default', () => {
    assert.throws(() => throwIfUnauthorized(new Response(null, { status: 401 })), { message: UNAUTHORIZED_MESSAGE });
    assert.throws(() => throwIfUnauthorized(new Response(null, { status: 428 })), { message: UNAUTHORIZED_MESSAGE });
    assert.doesNotThrow(() => throwIfUnauthorized(new Response(null, { status: 500 })));
});

test('authStatuses [401] keeps 428 flowing into error payload parsing', async () => {
    await assert.rejects(
        ensureOkResponse(jsonResponse(428, { error: 'setup required' }), '兜底消息', { authStatuses: [401] }),
        { message: 'setup required' },
    );
});

test('ok responses resolve without consuming the body', async () => {
    const response = jsonResponse(200, { value: 1 });
    await ensureOkResponse(response, '兜底消息');
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), { value: 1 });
});

test('safe mode prefers payload.error and falls back on invalid JSON', async () => {
    await assert.rejects(ensureOkResponse(jsonResponse(500, { error: 'boom' }), '兜底消息'), { message: 'boom' });
    await assert.rejects(ensureOkResponse(new Response('not json', { status: 500 }), '兜底消息'), { message: '兜底消息' });
});

test('strict mode propagates JSON parse failures like the legacy inline code', async () => {
    await assert.rejects(
        ensureOkResponse(new Response('not json', { status: 500 }), '兜底消息', { errorPayload: 'strict' }),
        (error: unknown) => error instanceof SyntaxError,
    );
});

test('none mode throws the fixed message without touching the body', async () => {
    const response = jsonResponse(500, { error: 'boom' });
    await assert.rejects(ensureOkResponse(response, '兜底消息', { errorPayload: 'none' }), { message: '兜底消息' });
    assert.equal(response.bodyUsed, false);
});

test('api.ts routes all fetch guards through the shared helpers', () => {
    assert.match(api, /ensureOkResponse/);
    assert.match(api, /throwIfUnauthorized/);
    assert.match(api, /UNAUTHORIZED_MESSAGE/);
    assert.ok(!api.includes("'UNAUTHORIZED'"), 'api.ts 不应再出现 UNAUTHORIZED 魔法字符串');
    assert.equal((api.match(/status === 401/g) || []).length, 1, '仅 XHR 上传路径保留自己的 401 检查');
    assert.equal((api.match(/status === 428/g) || []).length, 0);
});
