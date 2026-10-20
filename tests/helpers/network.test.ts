import { afterEach, describe, expect, it } from 'vitest';
import { blockNetwork } from './network';

const shared = globalThis as { __realFetch?: typeof fetch };
const saved = { fetch: globalThis.fetch, real: shared.__realFetch };

afterEach(() => {
	globalThis.fetch = saved.fetch;
	shared.__realFetch = saved.real;
});

describe('the network guard', () => {
	it('keeps the real fetch when setup runs again in the same worker', async () => {
		const real = (async () => new Response('real')) as typeof fetch;
		globalThis.fetch = real;
		delete shared.__realFetch;
		blockNetwork();
		blockNetwork();
		expect(shared.__realFetch).toBe(real);
		await expect(globalThis.fetch('https://example.com/')).rejects.toThrow(/must not use the network/);
	});
});
