import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'file-scope-test-'));

const { pool } = await import('../db/index.js');
const { storageManager } = await import('../services/storage.js');
const { getScopedFileById, updateScopedFileById } = await import('./fileScope.js');

const manager = storageManager as any;
const localProvider = manager.activeProvider;
const originalQuery = pool.query;

function captureQueries(result: { rows?: any[]; rowCount?: number } = {}) {
    const calls: { text: string; params: any[] }[] = [];
    (pool as any).query = async (text: string, params?: any[]) => {
        calls.push({ text, params: params ?? [] });
        return { rows: result.rows ?? [], rowCount: result.rowCount ?? 1 };
    };
    return calls;
}

function useCloudScope(accountId: string) {
    manager.activeProvider = { name: 's3' };
    manager.activeAccountId = accountId;
}

function restore() {
    (pool as any).query = originalQuery;
    manager.activeProvider = localProvider;
    manager.activeAccountId = null;
}

function assertPlaceholdersMatchParams(text: string, params: any[]) {
    const numbers = [...text.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.deepEqual([...numbers].sort((a, b) => a - b), params.map((_, index) => index + 1));
}

test('updateScopedFileById renumbers cloud scope placeholders after multi-field set values', async () => {
    try {
        useCloudScope('acct-9');
        const calls = captureQueries();
        await updateScopedFileById('file-1', 'name = $1, folder = $2, updated_at = NOW()', ['renamed', 'moved']);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].text, 'UPDATE files SET name = $1, folder = $2, updated_at = NOW() WHERE storage_account_id = $3 AND id = $4');
        assert.deepEqual(calls[0].params, ['renamed', 'moved', 'acct-9', 'file-1']);
        assert.doesNotMatch(calls[0].text, /storage_account_id = \$[12]\b/);
        assertPlaceholdersMatchParams(calls[0].text, calls[0].params);
    } finally {
        restore();
    }
});

test('updateScopedFileById keeps single-field cloud updates aligned with the id parameter', async () => {
    try {
        useCloudScope('acct-9');
        const calls = captureQueries({ rowCount: 3 });
        const updated = await updateScopedFileById('file-2', 'is_favorite = $1, updated_at = NOW()', [true]);
        assert.equal(updated, 3);
        assert.equal(calls[0].text, 'UPDATE files SET is_favorite = $1, updated_at = NOW() WHERE storage_account_id = $2 AND id = $3');
        assert.deepEqual(calls[0].params, [true, 'acct-9', 'file-2']);
        assertPlaceholdersMatchParams(calls[0].text, calls[0].params);
    } finally {
        restore();
    }
});

test('updateScopedFileById leaves the local scope clause untouched and appends only the id', async () => {
    try {
        const calls = captureQueries({ rowCount: 0 });
        const updated = await updateScopedFileById('file-3', 'name = $1', ['renamed']);
        assert.equal(updated, 0);
        assert.equal(calls[0].text, "UPDATE files SET name = $1 WHERE source = 'local' AND id = $2");
        assert.deepEqual(calls[0].params, ['renamed', 'file-3']);
        assertPlaceholdersMatchParams(calls[0].text, calls[0].params);
    } finally {
        restore();
    }
});

test('getScopedFileById offsets the id placeholder after cloud scope params', async () => {
    try {
        useCloudScope('acct-9');
        const calls = captureQueries({ rows: [{ id: 'file-4' }] });
        const file = await getScopedFileById('file-4');
        assert.deepEqual(file, { id: 'file-4' });
        assert.equal(calls[0].text, 'SELECT * FROM files WHERE storage_account_id = $1 AND id = $2');
        assert.deepEqual(calls[0].params, ['acct-9', 'file-4']);
        assertPlaceholdersMatchParams(calls[0].text, calls[0].params);
    } finally {
        restore();
    }
});
