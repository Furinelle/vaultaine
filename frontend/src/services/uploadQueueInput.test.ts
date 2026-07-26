import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachUploadSession, createUploadQueueInput, detachUploadSession } from './uploadQueueInput.js';

test('queued upload freezes provider, account, and folder at enqueue time', () => {
    const target = { provider: 'googledrive', accountId: 'account-a', accountName: 'Drive A', folder: 'original' };
    const input = createUploadQueueInput({ id: 'item' }, 'queued-folder', target);

    target.provider = 'onedrive';
    target.accountId = 'account-b';
    target.folder = 'changed';

    assert.deepEqual(input.target, {
        provider: 'googledrive',
        accountId: 'account-a',
        accountName: 'Drive A',
        folder: 'queued-folder',
    });
});

test('new chunk session is retained on the queue input so retry resumes it', () => {
    const input = createUploadQueueInput({ id: 'item' }, null, { provider: 'local', accountId: null });
    const session = { uploadId: 'upload-1' };
    attachUploadSession(input, session);
    assert.equal(input.resumeSession, session);
});

test('detaching a dead session makes retry restart as a fresh upload', () => {
    const input = createUploadQueueInput({ id: 'item' }, null, { provider: 'local', accountId: null });
    attachUploadSession(input, { uploadId: 'upload-1' });
    detachUploadSession(input);
    assert.equal(input.resumeSession, undefined);
});

test('App detaches the resume session when a chunked upload is cancelled', () => {
    const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    assert.match(app, /=== 'AbortError'\) detachUploadSession\(input\);/);
});