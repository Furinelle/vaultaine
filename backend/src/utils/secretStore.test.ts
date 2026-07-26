import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getExistingPersistentSecret, getOrCreatePersistentSecret, getPersistentSecretPath } from './secretStore.js';

const ENV_NAME = 'TG_VAULT_TEST_SECRET';
const FILE_NAME = 'test_secret';

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

async function withTempSecretEnv(run: (root: string) => void | Promise<void>): Promise<void> {
    const saved = {
        secretDir: process.env.TG_VAULT_SECRET_DIR,
        uploadDir: process.env.UPLOAD_DIR,
        testSecret: process.env[ENV_NAME],
    };
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-vault-secret-store-'));
    const cwd = process.cwd();
    try {
        process.chdir(root);
        process.env.TG_VAULT_SECRET_DIR = path.join(root, 'secrets');
        process.env.UPLOAD_DIR = path.join(root, 'data', 'uploads');
        delete process.env[ENV_NAME];
        await run(root);
    } finally {
        process.chdir(cwd);
        restoreEnv('TG_VAULT_SECRET_DIR', saved.secretDir);
        restoreEnv('UPLOAD_DIR', saved.uploadDir);
        restoreEnv(ENV_NAME, saved.testSecret);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

test('generates, persists and reuses a secret when env and file are absent', async () => {
    await withTempSecretEnv(async () => {
        const first = getOrCreatePersistentSecret(ENV_NAME, FILE_NAME);
        assert.match(first, /^[0-9a-f]{64}$/);
        const filePath = getPersistentSecretPath(FILE_NAME);
        assert.equal(fs.readFileSync(filePath, 'utf8'), `${first}\n`);
        assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
        assert.equal(getOrCreatePersistentSecret(ENV_NAME, FILE_NAME), first);
        assert.equal(getExistingPersistentSecret(FILE_NAME), first);
    });
});

test('environment value wins and is persisted when no file exists', async () => {
    await withTempSecretEnv(async () => {
        process.env[ENV_NAME] = 'env-provided-secret';
        assert.equal(getOrCreatePersistentSecret(ENV_NAME, FILE_NAME), 'env-provided-secret');
        assert.equal(fs.readFileSync(getPersistentSecretPath(FILE_NAME), 'utf8'), 'env-provided-secret\n');
    });
});

test('persisted file value is returned trimmed when env is unset', async () => {
    await withTempSecretEnv(async () => {
        const filePath = getPersistentSecretPath(FILE_NAME);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '  file-secret \n');
        assert.equal(getOrCreatePersistentSecret(ENV_NAME, FILE_NAME), 'file-secret');
        assert.equal(getExistingPersistentSecret(FILE_NAME), 'file-secret');
    });
});

test('conflicting env value is used for the process without overwriting the persisted file', async () => {
    await withTempSecretEnv(async () => {
        const filePath = getPersistentSecretPath(FILE_NAME);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'persisted-secret\n');
        process.env[ENV_NAME] = 'different-env-secret';
        assert.equal(getOrCreatePersistentSecret(ENV_NAME, FILE_NAME), 'different-env-secret');
        assert.equal(fs.readFileSync(filePath, 'utf8'), 'persisted-secret\n');
    });
});

test('getExistingPersistentSecret returns empty string when nothing is stored', async () => {
    await withTempSecretEnv(async () => {
        assert.equal(getExistingPersistentSecret(FILE_NAME), '');
    });
});

test('secret stored under the upload-dir sibling directory is still found', async () => {
    await withTempSecretEnv(async (root) => {
        const fallbackDir = path.join(root, 'data', 'secrets');
        fs.mkdirSync(fallbackDir, { recursive: true });
        fs.writeFileSync(path.join(fallbackDir, FILE_NAME), 'fallback-value\n');
        assert.equal(getExistingPersistentSecret(FILE_NAME), 'fallback-value');
        assert.equal(getOrCreatePersistentSecret(ENV_NAME, FILE_NAME), 'fallback-value');
    });
});

test('persist falls back to the next candidate dir when the preferred dir is unusable', async () => {
    await withTempSecretEnv(async (root) => {
        const blocked = path.join(root, 'blocked');
        fs.writeFileSync(blocked, 'not a directory');
        process.env.TG_VAULT_SECRET_DIR = blocked;
        const secret = getOrCreatePersistentSecret(ENV_NAME, FILE_NAME);
        assert.match(secret, /^[0-9a-f]{64}$/);
        const fallbackPath = path.join(root, 'data', 'secrets', FILE_NAME);
        assert.equal(fs.readFileSync(fallbackPath, 'utf8'), `${secret}\n`);
        assert.equal(getExistingPersistentSecret(FILE_NAME), secret);
    });
});
