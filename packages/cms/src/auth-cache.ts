/** Shared in-memory token cache for GitHub OAuth sessions. */

interface CachedUser {
  user: { login: string; name: string; email: string; avatar: string };
  expires: number;
}

export const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 500;

const tokenCache = new Map<string, CachedUser>();

/** Insert or refresh a token entry. Evicts expired entries first; if still over limit, drops oldest. */
export function cacheToken(
  token: string,
  user: CachedUser['user'],
): void {
  // Evict expired entries
  const now = Date.now();
  for (const [k, v] of tokenCache) {
    if (v.expires <= now) tokenCache.delete(k);
  }
  // Hard cap: evict oldest (Map insertion order)
  if (tokenCache.size >= MAX_CACHE_SIZE) {
    const oldest = tokenCache.keys().next().value;
    if (oldest) tokenCache.delete(oldest);
  }
  tokenCache.set(token, { user, expires: now + CACHE_TTL });
}

/** Return the cached user if the token is present and not expired, otherwise null. */
export function getCachedUser(token: string): CachedUser['user'] | null {
  const entry = tokenCache.get(token);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    tokenCache.delete(token);
    return null;
  }
  return entry.user;
}

/** Check whether a token has a valid (non-expired) cache entry — without returning the user. */
export function isTokenCached(token: string): boolean {
  return getCachedUser(token) !== null;
}

/** Remove a token from the cache (called on logout). */
export function invalidateToken(token: string): void {
  tokenCache.delete(token);
}
