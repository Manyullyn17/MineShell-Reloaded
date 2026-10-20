/**
 * Makes fetch throw unless a test file replays recorded responses with
 * useRecordedHttp() (tests/helpers/http.ts), keeping the real fetch for
 * recording (RECORD_HTTP=1) in globalThis.__realFetch.
 *
 * Kept from the first call only: files that share modules (vite.config.ts) run
 * tests/setup.ts again in the same worker, where fetch is already this guard,
 * and keeping that let every file after a worker's first record nothing but
 * "Tests must not use the network".
 */
export function blockNetwork(): void {
	const shared = globalThis as { __realFetch?: typeof fetch };
	shared.__realFetch ??= globalThis.fetch;
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		throw new Error(`Tests must not use the network (tried: ${url}). Use useRecordedHttp() from tests/helpers/http.ts.`);
	}) as typeof fetch;
}
