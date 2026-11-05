import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cached, CACHE_MAX_ENTRIES, invalidateCache, invalidateCachePrefix } from './cache';

const TTL = 60_000;
const answers = (...values: unknown[]) => {
	const fetcher = vi.fn();
	for (const value of values) fetcher.mockResolvedValueOnce(value);
	return fetcher;
};
const later = () => {
	let finish = (_value: string) => {};
	const promise = new Promise<string>((resolve) => (finish = resolve));
	return { promise, finish };
};

describe('cached', () => {
	beforeEach(() => invalidateCache());
	// Workers are shared between test files: a fake clock left on stalls whichever comes next.
	afterEach(() => vi.useRealTimers());

	it('answers from the cache until the entry expires', async () => {
		vi.useFakeTimers();
		const fetcher = answers('one', 'two');
		expect(await cached('k', TTL, fetcher)).toBe('one');
		expect(await cached('k', TTL, fetcher)).toBe('one');
		vi.advanceTimersByTime(TTL);
		expect(await cached('k', TTL, fetcher)).toBe('two');
	});

	it('keeps no failure: the next call fetches again', async () => {
		const fetcher = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce('up');
		await expect(cached('k', TTL, fetcher)).rejects.toThrow('down');
		expect(await cached('k', TTL, fetcher)).toBe('up');
	});

	it('fresh fetches past a stored answer and replaces it', async () => {
		const fetcher = answers('old', 'new');
		await cached('k', TTL, fetcher);
		expect(await cached('k', TTL, fetcher, { fresh: true })).toBe('new');
		expect(await cached('k', TTL, fetcher)).toBe('new');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('does not store what keep turns down, and leaves an older answer alone', async () => {
		const keep = (hits: string[]) => hits.length > 0;
		const fetcher = answers(['hit'], [], [], ['again']);
		await cached('k', TTL, fetcher, { keep });
		expect(await cached('k', TTL, fetcher, { keep, fresh: true })).toEqual([]);
		expect(await cached('k', TTL, fetcher, { keep })).toEqual(['hit']);
		invalidateCache();
		expect(await cached('k', TTL, fetcher, { keep })).toEqual([]);
		expect(await cached('k', TTL, fetcher, { keep })).toEqual(['again']);
	});

	it('gives two callers of the same fetch one request', async () => {
		const { promise, finish } = later();
		const fetcher = vi.fn(() => promise);
		const both = Promise.all([cached('k', TTL, fetcher), cached('k', TTL, fetcher)]);
		finish('shared');
		expect(await both).toEqual(['shared', 'shared']);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('keeps a fresh answer over a slower older fetch', async () => {
		const slow = later();
		const old = cached('k', TTL, () => slow.promise);
		expect(await cached('k', TTL, async () => 'new', { fresh: true })).toBe('new');
		slow.finish('old');
		await old;
		expect(await cached('k', TTL, async () => 'unused')).toBe('new');
	});

	it('does not store a fetch that started before its key was invalidated', async () => {
		const slow = later();
		const old = cached('catalog:a', TTL, () => slow.promise);
		invalidateCachePrefix('catalog:');
		slow.finish('old');
		await old;
		expect(await cached('catalog:a', TTL, async () => 'new')).toBe('new');
	});

	it('invalidates only the keys under a prefix', async () => {
		const fetcher = answers('a', 'b', 'a again');
		await cached('one:x', TTL, fetcher);
		await cached('two:x', TTL, fetcher);
		invalidateCachePrefix('one:');
		expect(await cached('two:x', TTL, fetcher)).toBe('b');
		expect(await cached('one:x', TTL, fetcher)).toBe('a again');
	});

	it('over the limit drops what expired, then the oldest', async () => {
		vi.useFakeTimers();
		await cached('expires', 10, async () => 'gone');
		await cached('oldest', TTL, async () => 'dropped');
		await cached('next', TTL, async () => 'stays');
		vi.advanceTimersByTime(10);
		for (let i = 3; i < CACHE_MAX_ENTRIES; i++) await cached(`k${i}`, TTL, async () => i);
		// Exactly full: this one takes the expired entry's place, nothing live goes.
		await cached('one more', TTL, async () => 'in');
		expect(await cached('oldest', TTL, async () => 'fetched')).toBe('dropped');
		await cached('and another', TTL, async () => 'in');
		expect(await cached('next', TTL, async () => 'fetched')).toBe('stays');
		expect(await cached('oldest', TTL, async () => 'fetched')).toBe('fetched');
	});
});
