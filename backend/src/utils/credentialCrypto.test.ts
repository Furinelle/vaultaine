import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    decryptCredential,
    decryptSettingValue,
    decryptStorageConfig,
    encryptCredential,
    encryptSettingValue,
    encryptStorageConfig,
    isEncryptedCredential,
    isSensitiveSettingKey,
    storageConfigNeedsEncryption,
} from './credentialCrypto.js';

const SECRET_A = 'credential-crypto-test-secret-A-0123456789';
const SECRET_B = 'credential-crypto-test-secret-B-9876543210';

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

async function withCredentialSecret(secret: string | undefined, run: () => void | Promise<void>): Promise<void> {
    const saved = {
        secretDir: process.env.TG_VAULT_SECRET_DIR,
        uploadDir: process.env.UPLOAD_DIR,
        storageSecret: process.env.STORAGE_CREDENTIALS_SECRET,
        sessionSecret: process.env.SESSION_SECRET,
    };
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-vault-cred-crypto-'));
    const cwd = process.cwd();
    try {
        process.chdir(root);
        process.env.TG_VAULT_SECRET_DIR = path.join(root, 'secrets');
        process.env.UPLOAD_DIR = path.join(root, 'data', 'uploads');
        delete process.env.SESSION_SECRET;
        if (secret === undefined) delete process.env.STORAGE_CREDENTIALS_SECRET;
        else process.env.STORAGE_CREDENTIALS_SECRET = secret;
        await run();
    } finally {
        process.chdir(cwd);
        restoreEnv('TG_VAULT_SECRET_DIR', saved.secretDir);
        restoreEnv('UPLOAD_DIR', saved.uploadDir);
        restoreEnv('STORAGE_CREDENTIALS_SECRET', saved.storageSecret);
        restoreEnv('SESSION_SECRET', saved.sessionSecret);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

function flipByte(encrypted: string, partIndex: number): string {
    const parts = encrypted.split(':');
    const buf = Buffer.from(parts[partIndex], 'base64url');
    buf[0] ^= 0x01;
    parts[partIndex] = buf.toString('base64url');
    return parts.join(':');
}

test('encrypt/decrypt round-trips ascii, chinese, symbol-heavy and long values', async () => {
    await withCredentialSecret(SECRET_A, () => {
        const values = [
            'plain-secret',
            '云端凭据密钥测试值',
            'token:with:colons/and+symbols==',
            '🔐水神🔐',
            'x'.repeat(20000),
        ];
        for (const value of values) {
            const encrypted = encryptCredential(value);
            assert.ok(isEncryptedCredential(encrypted));
            assert.ok(encrypted.startsWith('enc:v1:'));
            assert.ok(!encrypted.includes(value));
            assert.equal(decryptCredential(encrypted), value);
        }
    });
});

test('empty string passes through unencrypted in both directions', async () => {
    await withCredentialSecret(SECRET_A, () => {
        assert.equal(encryptCredential(''), '');
        assert.equal(decryptCredential(''), '');
        assert.equal(isEncryptedCredential(''), false);
    });
});

test('already-encrypted values are not double-encrypted and plaintext decrypt is passthrough', async () => {
    await withCredentialSecret(SECRET_A, () => {
        const encrypted = encryptCredential('value');
        assert.equal(encryptCredential(encrypted), encrypted);
        assert.equal(decryptCredential('not-encrypted'), 'not-encrypted');
        assert.equal(isEncryptedCredential(42), false);
        assert.equal(isEncryptedCredential(null), false);
    });
});

test('each encryption uses a fresh IV so ciphertexts differ but both decrypt', async () => {
    await withCredentialSecret(SECRET_A, () => {
        const first = encryptCredential('same-plaintext');
        const second = encryptCredential('same-plaintext');
        assert.notEqual(first, second);
        assert.equal(decryptCredential(first), 'same-plaintext');
        assert.equal(decryptCredential(second), 'same-plaintext');
    });
});

test('malformed encrypted payloads are rejected', async () => {
    await withCredentialSecret(SECRET_A, () => {
        assert.throws(() => decryptCredential('enc:v1:'), /Invalid encrypted credential format/);
        assert.throws(() => decryptCredential('enc:v1:only-iv'), /Invalid encrypted credential format/);
        assert.throws(() => decryptCredential('enc:v1:iv:tag'), /Invalid encrypted credential format/);
    });
});

test('tampered iv, tag or ciphertext fails decryption instead of returning garbage', async () => {
    await withCredentialSecret(SECRET_A, () => {
        const encrypted = encryptCredential('sensitive-value');
        for (const partIndex of [2, 3, 4]) {
            assert.throws(() => decryptCredential(flipByte(encrypted, partIndex)));
        }
        assert.equal(decryptCredential(encrypted), 'sensitive-value');
    });
});

test('decryption fails under a rotated secret and recovers when the original returns', async () => {
    await withCredentialSecret(SECRET_A, () => {
        const encrypted = encryptCredential('rotate-me');
        process.env.STORAGE_CREDENTIALS_SECRET = SECRET_B;
        assert.throws(() => decryptCredential(encrypted));
        process.env.STORAGE_CREDENTIALS_SECRET = SECRET_A;
        assert.equal(decryptCredential(encrypted), 'rotate-me');
    });
});

test('decryption survives losing the env secret via the persisted secret file', async () => {
    await withCredentialSecret(SECRET_A, () => {
        const encrypted = encryptCredential('survives-restart');
        delete process.env.STORAGE_CREDENTIALS_SECRET;
        assert.equal(decryptCredential(encrypted), 'survives-restart');
    });
});

test('encryption works with a generated secret when no env secret is configured', async () => {
    await withCredentialSecret(undefined, () => {
        const encrypted = encryptCredential('generated-secret-flow');
        assert.ok(isEncryptedCredential(encrypted));
        assert.equal(decryptCredential(encrypted), 'generated-secret-flow');
    });
});

test('secrets shorter than 32 characters are rejected', async () => {
    await withCredentialSecret('too-short', () => {
        assert.throws(() => encryptCredential('x'), /at least 32 characters/);
    });
});

test('secret shared with SESSION_SECRET is rejected', async () => {
    await withCredentialSecret(SECRET_A, () => {
        process.env.SESSION_SECRET = SECRET_A;
        assert.throws(() => encryptCredential('x'), /independent from SESSION_SECRET/);
    });
});

test('storage config encrypts only sensitive keys and round-trips', async () => {
    await withCredentialSecret(SECRET_A, () => {
        const config = {
            type: 'r2',
            endpoint: 'https://example.com',
            accessKeyId: 'key-id',
            accessKeySecret: 'key-secret',
            clientSecret: 'client-secret',
            refreshToken: 'refresh-token',
            password: 'webdav-password',
            username: 'user',
        };
        const encrypted = encryptStorageConfig(config);
        assert.equal(encrypted.type, 'r2');
        assert.equal(encrypted.endpoint, 'https://example.com');
        assert.equal(encrypted.accessKeyId, 'key-id');
        assert.equal(encrypted.username, 'user');
        for (const key of ['accessKeySecret', 'clientSecret', 'refreshToken', 'password'] as const) {
            assert.ok(isEncryptedCredential(encrypted[key]));
        }
        assert.equal(config.password, 'webdav-password');
        assert.deepEqual(decryptStorageConfig(encrypted), config);
    });
});

test('storageConfigNeedsEncryption detects plaintext sensitive values only', async () => {
    await withCredentialSecret(SECRET_A, () => {
        const config = { type: 'webdav', password: 'plaintext', username: 'user' };
        assert.equal(storageConfigNeedsEncryption(config), true);
        assert.equal(storageConfigNeedsEncryption(encryptStorageConfig(config)), false);
        assert.equal(storageConfigNeedsEncryption({ type: 'local', path: '/x' }), false);
        assert.equal(storageConfigNeedsEncryption({ password: '' }), false);
    });
});

test('setting values are encrypted only for sensitive keys', async () => {
    await withCredentialSecret(SECRET_A, () => {
        assert.equal(isSensitiveSettingKey('onedrive_client_secret'), true);
        assert.equal(isSensitiveSettingKey('site_title'), false);
        const encrypted = encryptSettingValue('google_drive_refresh_token', 'refresh-token');
        assert.ok(isEncryptedCredential(encrypted));
        assert.equal(decryptSettingValue('google_drive_refresh_token', encrypted), 'refresh-token');
        assert.equal(encryptSettingValue('site_title', 'Vault'), 'Vault');
        assert.equal(decryptSettingValue('site_title', 'Vault'), 'Vault');
    });
});
