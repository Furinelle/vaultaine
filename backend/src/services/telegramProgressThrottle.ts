export function shouldRefreshSilentProgress(
    lastRefreshAt: number | undefined,
    now = Date.now(),
    force = false,
    cooldownMs = 30_000,
): boolean {
    return force || lastRefreshAt === undefined || now - lastRefreshAt >= cooldownMs;
}
