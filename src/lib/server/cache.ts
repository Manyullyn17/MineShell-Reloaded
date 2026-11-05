/**
 * In-memory TTL cache for outbound API calls. Nothing here is persisted -
 * losing it on restart just means the next request re-fetches, which is fine
 * for data this cheap to re-fetch and this slow to change.
 *
 * Mirrors the shape of the old Python version's @cached decorator: call
 * cached() with a key, a TTL, and the fetch to run on a miss.
 */

type Entry<T> = { value: T; expiresAt: number };
type Options<T> = {
	/** Skip what is stored and fetch again; the answer replaces it. */
	fresh?: boolean;
	/** Whether this answer is worth storing. Unset, every answer is. */
	keep?: (value: T) => boolean;
};

const store = new Map<string, Entry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export const CACHE_TTL = {
	/** Category/loader tag lists - effectively static. */
	TAGS: 24 * 60 * 60_000,
	/** Searches, project details, a mirror's mod files - matches the old app's TTL. */
	DEFAULT: 10 * 60_000
} as const;

/**
 * Entries kept in all. Above what one update check adds (each mod of a big pack brings two
 * from the mirror, and 200 would throw them out during the check), and each search types a few.
 */
export const CACHE_MAX_ENTRIES = 2000;

function remember<T>(key: string, value: T, ttlMs: number): void {
	// Set again to count as the newest: a Map keeps the order keys went in.
	store.delete(key);
	store.set(key, { value, expiresAt: Date.now() + ttlMs });
	if (store.size <= CACHE_MAX_ENTRIES) return;
	const now = Date.now();
	for (const [old, entry] of store) if (entry.expiresAt <= now) store.delete(old);
	for (const old of store.keys()) {
		if (store.size <= CACHE_MAX_ENTRIES) break;
		store.delete(old);
	}
}

export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>, { fresh = false, keep }: Options<T> = {}): Promise<T> {
	if (!fresh) {
		const hit = store.get(key);
		if (hit && hit.expiresAt > Date.now()) return hit.value as T;
		// The same fetch already on its way: two callers share one request.
		const running = inFlight.get(key);
		if (running) return running as Promise<T>;
	}

	const run: Promise<T> = fetcher().then((value) => {
		// A failed fetch should not poison the cache with a permanent miss. One overtaken
		// by a fresh fetch, or by invalidateCache, is older than what the cache should hold.
		if (inFlight.get(key) === run && (keep?.(value) ?? true)) remember(key, value, ttlMs);
		return value;
	});
	inFlight.set(key, run);
	try {
		return await run;
	} finally {
		if (inFlight.get(key) === run) inFlight.delete(key);
	}
}

/** Mostly for tests and the rare case a stale entry needs clearing by hand. */
export function invalidateCache(key?: string): void {
	if (key) {
		store.delete(key);
		inFlight.delete(key);
	} else {
		store.clear();
		inFlight.clear();
	}
}

/** Everything under a key prefix, for when what its answers depend on changed. */
export function invalidateCachePrefix(prefix: string): void {
	for (const map of [store, inFlight]) {
		for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
	}
}
