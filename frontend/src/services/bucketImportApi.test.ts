import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import runtimeEn from '../locales/runtime-en.json' with { type: 'json' };

const bucketImportApi = fs.readFileSync(new URL('./bucketImportApi.ts', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');

test('bucket import client starts a background task and polls its status', () => {
    assert.match(bucketImportApi, /method: 'POST'/);
    assert.match(bucketImportApi, /import-from-bucket\/tasks\/\$\{encodeURIComponent\(taskId\)\}/);
    assert.match(bucketImportApi, /response\.status === 404\) throw new Error\('IMPORT_TASK_LOST'\)/);
    assert.match(bucketImportApi, /response\.status === 401 \|\| response\.status === 428\) throw new Error\('UNAUTHORIZED'\)/);
    assert.match(settings, /startBucketImport\(\)/);
    assert.match(settings, /getBucketImportTask\(taskId\)/);
    assert.match(settings, /task\.status === 'completed'/);
    assert.match(settings, /task\.status === 'failed'/);
});

test('settings page polls through the transient-failure tolerant helper, not a bare loop', () => {
    assert.match(settings, /pollBucketImportTask\(\(\) => getBucketImportTask\(taskId\), \{ onProgress: setImportProgress \}\)/);
    // 裸 for(;;) + setTimeout 轮询对单次网络抖动零容忍，已由 bucketImportPolling 取代
    assert.doesNotMatch(settings, /setTimeout\(resolve, 2000\)/);
});

test('settings page maps import sentinels to friendly dialogs instead of raw codes', () => {
    assert.match(settings, /error\?\.message === 'UNAUTHORIZED'/);
    assert.match(settings, /'UNAUTHORIZED'\) \{\s*authService\.clearToken\(\);/);
    assert.match(settings, /onSignedOut\?\.\(\);\s*return;/);
    assert.match(settings, /error\?\.message === 'IMPORT_TASK_LOST'/);
    assert.match(settings, /登录已过期，请重新登录后再继续导入。/);
    assert.match(settings, /服务在导入期间重启，本次导入已中断/);
    assert.doesNotMatch(settings, /showNotice\('从存储桶导入失败: ' \+ error\.message.*UNAUTHORIZED/);
});

test('runtime English catalog covers the bucket import journey', () => {
    const catalog = runtimeEn as Record<string, string>;
    const required = ['从存储桶导入', '正在导入...', '导入完成', '导入失败', '导入中断', '登录已过期', '登录已过期，请重新登录后再继续导入。'];
    for (const text of required) assert.equal(typeof catalog[text], 'string', `missing ${text}`);
});
