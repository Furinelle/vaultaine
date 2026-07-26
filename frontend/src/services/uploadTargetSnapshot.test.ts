import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUploadTargetSnapshot } from './uploadTargetSnapshot.js';

test('upload target keeps the raw provider id instead of the display label', () => {
    assert.deepEqual(
        buildUploadTargetSnapshot(
            {
                provider: 's3',
                activeAccountId: 'account-1',
                activeAccountName: 'Cloudflare R2',
            },
            {
                provider: 'S3',
                account: 'Cloudflare R2',
            },
            '妙妙菠萝朋友圈',
        ),
        {
            provider: 's3',
            accountId: 'account-1',
            accountName: 'Cloudflare R2',
            folder: '妙妙菠萝朋友圈',
        },
    );
});
