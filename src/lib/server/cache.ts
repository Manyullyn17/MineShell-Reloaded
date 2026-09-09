/**
 * In-memory TTL cache for outbound API calls. Nothing here is persisted -
 * losing it on restart just means the next request re-fetches, which is fine
 * for data this cheap to re-fetch and this slow to change.
 *
 * Mirrors the shape of the old Python version's @cached decorator: call
 * cached() with a key, a TTL, and the fetch to run on a miss.
 */

type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();

export const CACHE_TTL = {
	/** Category/loader tag lists - effectively static. */
	TAGS: 24 * 60 * 60_000,
	/** Search results, project details, version lists - matches the old app's TTL. */
	DEFAULT: 10 * 60_000
} as const;

export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
	const hit = store.get(key);
	if (hit && hit.expiresAt > Date.now()) return hit.value as T;

	const value = await fetcher();
	// A failed fetch should not poison the cache with a permanent miss, but a
	// genuinely empty (and valid) result is still worth caching briefly.
	store.set(key, { value, expiresAt: Date.now() + ttlMs });
	return value;
}

/** Mostly for tests and the rare case a stale entry needs clearing by hand. */
export function invalidateCache(key?: string): void {
	if (key) store.delete(key);
	else store.clear();
}
