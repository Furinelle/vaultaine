export const UNAUTHORIZED_MESSAGE = 'UNAUTHORIZED';

const DEFAULT_AUTH_STATUSES: readonly number[] = [401, 428];

export interface ResponseGuardOptions {
    authStatuses?: readonly number[];
    errorPayload?: 'safe' | 'strict' | 'none';
}

export function throwIfUnauthorized(response: Response, authStatuses: readonly number[] = DEFAULT_AUTH_STATUSES): void {
    if (authStatuses.includes(response.status)) throw new Error(UNAUTHORIZED_MESSAGE);
}

export async function ensureOkResponse(response: Response, fallbackMessage: string, options: ResponseGuardOptions = {}): Promise<void> {
    throwIfUnauthorized(response, options.authStatuses);
    if (response.ok) return;
    if (options.errorPayload === 'none') throw new Error(fallbackMessage);
    const payload = options.errorPayload === 'strict'
        ? await response.json()
        : await response.json().catch(() => ({}));
    throw new Error(payload.error || fallbackMessage);
}
