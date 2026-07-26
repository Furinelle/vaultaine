import type { UploadTargetSnapshot } from './api';

interface StorageSelection {
    provider: string;
    activeAccountId: string | null;
    activeAccountName?: string | null;
}

interface StorageDisplay {
    provider: string;
    account: string;
}

export function buildUploadTargetSnapshot(
    storage: StorageSelection | null,
    display: StorageDisplay | null,
    folder?: string,
): UploadTargetSnapshot {
    return {
        // API contracts use stable provider ids such as "s3"; display labels such
        // as "S3" are only for UI text and must never be sent to the backend.
        provider: storage?.provider || 'local',
        accountId: storage?.activeAccountId || null,
        accountName: display?.account || storage?.activeAccountName || null,
        folder: folder || null,
    };
}
