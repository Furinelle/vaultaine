import { authService } from './auth';
import { API_BASE } from './config';

export interface BucketImportTask {
    id: string;
    status: 'running' | 'completed' | 'failed';
    scanned: number;
    imported: number;
    skipped: number;
    excluded: number;
    error: string | null;
}

// 从当前活跃的 S3 存储桶导入未入库文件：立即返回后台任务 ID，进度靠轮询任务端点
export async function startBucketImport(): Promise<{ taskId: string }> {
    const response = await fetch(`${API_BASE}/api/storage/import-from-bucket`, {
        credentials: 'include',
        method: 'POST',
        headers: authService.getAuthHeaders(),
    });
    if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || '从存储桶导入失败');
    }
    const data = await response.json();
    if (!data || typeof data.taskId !== 'string' || !data.taskId) throw new Error('从存储桶导入失败');
    return { taskId: data.taskId };
}

// 任务表在服务端内存中：404 意味着服务已重启、任务已中断，用 IMPORT_TASK_LOST 哨兵上抛
export async function getBucketImportTask(taskId: string): Promise<BucketImportTask> {
    const response = await fetch(`${API_BASE}/api/storage/import-from-bucket/tasks/${encodeURIComponent(taskId)}`, {
        credentials: 'include',
        headers: authService.getAuthHeaders(),
    });
    if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
    if (response.status === 404) throw new Error('IMPORT_TASK_LOST');
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || '查询导入进度失败');
    }
    return response.json();
}
