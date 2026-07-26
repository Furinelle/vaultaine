import type { BucketImportTask } from './bucketImportApi';

export const BUCKET_IMPORT_POLL_INTERVAL_MS = 2000;
export const BUCKET_IMPORT_MAX_TRANSIENT_FAILURES = 5;

export interface PollBucketImportOptions {
    onProgress?: (task: BucketImportTask) => void;
    delay?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    maxTransientFailures?: number;
}

const defaultDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// 轮询后台导入任务直至终态（completed/failed）。网络级瞬时失败（wifi 抖动、休眠恢复、
// 后端重启窗口 connection refused）不立即判死：连续失败会以递增间隔重试，只有连续
// maxTransientFailures 次失败才上抛；成功一次即重置计数。UNAUTHORIZED（401）与
// IMPORT_TASK_LOST（404，服务已重启）保持既有语义，立即上抛终止轮询。
export async function pollBucketImportTask(
    fetchTask: () => Promise<BucketImportTask>,
    options: PollBucketImportOptions = {},
): Promise<BucketImportTask> {
    const {
        onProgress,
        delay = defaultDelay,
        pollIntervalMs = BUCKET_IMPORT_POLL_INTERVAL_MS,
        maxTransientFailures = BUCKET_IMPORT_MAX_TRANSIENT_FAILURES,
    } = options;
    let transientFailures = 0;
    for (;;) {
        await delay(pollIntervalMs * (transientFailures + 1));
        try {
            const task = await fetchTask();
            transientFailures = 0;
            onProgress?.(task);
            if (task.status === 'completed' || task.status === 'failed') return task;
        } catch (error: any) {
            if (error?.message === 'UNAUTHORIZED' || error?.message === 'IMPORT_TASK_LOST') throw error;
            transientFailures += 1;
            if (transientFailures >= maxTransientFailures) throw error;
        }
    }
}
