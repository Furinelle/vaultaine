import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeFolderPath } from '../utils/folderPath.js';

export interface BucketObject {
    key: string;
    size: number;
}

export interface BucketImportPage {
    objects: BucketObject[];
    nextContinuationToken?: string;
}

export interface BucketImportRecord {
    name: string;
    storedName: string;
    path: string;
    folder: string | null;
    size: number;
}

const INVALID_FILE_NAME_CHARACTERS = /[\\\x00-\x1f\x7f]/;

export function normalizeBucketObjectForImport(object: BucketObject): BucketImportRecord | null {
    const key = typeof object.key === 'string' ? object.key : '';
    if (!key || key.length > 500 || key.startsWith('_backups/') || key.endsWith('/')) return null;
    if (!Number.isSafeInteger(object.size) || object.size < 0) return null;

    const separator = key.lastIndexOf('/');
    const baseName = separator >= 0 ? key.slice(separator + 1) : key;
    if (!baseName || baseName.length > 255 || INVALID_FILE_NAME_CHARACTERS.test(baseName)) return null;

    let folder: string | null = null;
    if (separator >= 0) {
        try {
            folder = normalizeFolderPath(key.slice(0, separator));
        } catch {
            return null;
        }
    }

    // POSIX basename is intentionally checked after folder normalization so
    // relative path segments and alternate separators cannot enter the index.
    if (path.posix.basename(key) !== baseName) return null;
    return {
        name: baseName,
        storedName: baseName,
        path: key,
        folder,
        size: object.size,
    };
}

export interface BucketImportProgress {
    scanned: number;
    imported: number;
    skipped: number;
    excluded: number;
}

export async function runBucketImport(options: {
    listPage: (continuationToken?: string) => Promise<BucketImportPage>;
    insertBatch: (records: BucketImportRecord[]) => Promise<number>;
    onProgress?: (progress: BucketImportProgress) => void;
}): Promise<BucketImportProgress> {
    let continuationToken: string | undefined;
    const seenTokens = new Set<string>();
    const result = { scanned: 0, imported: 0, skipped: 0, excluded: 0 };

    do {
        const page = await options.listPage(continuationToken);
        result.scanned += page.objects.length;
        const records = page.objects
            .map(normalizeBucketObjectForImport)
            .filter((record): record is BucketImportRecord => record !== null);
        result.excluded += page.objects.length - records.length;

        if (records.length > 0) {
            const inserted = await options.insertBatch(records);
            if (!Number.isSafeInteger(inserted) || inserted < 0 || inserted > records.length) {
                throw new Error('存储桶导入写入计数无效');
            }
            result.imported += inserted;
            result.skipped += records.length - inserted;
        }

        options.onProgress?.({ ...result });
        const nextToken = page.nextContinuationToken;
        if (nextToken && seenTokens.has(nextToken)) {
            throw new Error('存储桶分页游标重复');
        }
        if (nextToken) seenTokens.add(nextToken);
        continuationToken = nextToken;
    } while (continuationToken);

    return result;
}

export type BucketImportTaskStatus = 'running' | 'completed' | 'failed';

export interface BucketImportTaskSnapshot extends BucketImportProgress {
    id: string;
    accountId: string;
    status: BucketImportTaskStatus;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
}

const importTasks = new Map<string, BucketImportTaskSnapshot>();
const FINISHED_TASK_RETENTION = 20;

function pruneFinishedImportTasks(): void {
    const finished = [...importTasks.values()]
        .filter(task => task.status !== 'running')
        .sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
    for (const task of finished.slice(0, Math.max(0, finished.length - FINISHED_TASK_RETENTION))) {
        importTasks.delete(task.id);
    }
}

export function getBucketImportTask(id: string): BucketImportTaskSnapshot | null {
    const task = importTasks.get(id);
    return task ? { ...task } : null;
}

export function startBucketImportTask(options: {
    accountId: string;
    run: (onProgress: (progress: BucketImportProgress) => void) => Promise<BucketImportProgress>;
    onSettled?: (task: BucketImportTaskSnapshot) => Promise<void> | void;
}): BucketImportTaskSnapshot {
    const task: BucketImportTaskSnapshot = {
        id: randomUUID(),
        accountId: options.accountId,
        status: 'running',
        scanned: 0,
        imported: 0,
        skipped: 0,
        excluded: 0,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
    };
    importTasks.set(task.id, task);
    void (async () => {
        try {
            const result = await options.run(progress => Object.assign(task, progress));
            Object.assign(task, result);
            task.status = 'completed';
        } catch (error) {
            task.status = 'failed';
            task.error = error instanceof Error ? error.message : String(error);
        } finally {
            task.finishedAt = new Date().toISOString();
            pruneFinishedImportTasks();
            try {
                await options.onSettled?.({ ...task });
            } catch (settleError) {
                console.error('存储桶导入任务收尾失败:', settleError);
            }
        }
    })();
    return { ...task };
}
