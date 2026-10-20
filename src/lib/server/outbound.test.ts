import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { outboundFetch, resetServiceStates, serviceName, serviceStates } from './outbound';

const realFetch = globalThis.fetch;
let answer: (url: string) => Response | Promise<Response>;

beforeEach(() => {
	resetServiceStates();
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => answer(String(input))) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.useRealTimers();
});

const offline = (code: string) => () => {
	throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
};
const state = (name: string) => serviceStates().find((s) => s.name === name);

describe('outbound requests', () => {
	it('group hosts into the services they belong to', () => {
		expect(serviceName('https://api.modrinth.com/v2/project/x')).toBe('Modrinth');
		expect(serviceName('https://cdn.modrinth.com/data/x.jar')).toBe('Modrinth');
		expect(serviceName('https://dist.modpacks.ch/x')).toBe('modpacks.ch (FTB, CurseForge mirror)');
		expect(serviceName('https://edge.forgecdn.net/files/1/2/x.jar')).toBe('CurseForge downloads');
		expect(serviceName('https://piston-meta.mojang.com/v1/x.json')).toBe('Mojang');
		// A look-alike is not the service.
		expect(serviceName('https://notmodrinth.com/x')).toBe('notmodrinth.com');
		expect(serviceName('https://example.org/pack.png')).toBe('example.org');
	});

	it('count an answer as working, even a 404, and a 5xx, 429 or no answer as failing', async () => {
		answer = () => new Response('gone', { status: 404 });
		await outboundFetch('https://api.modrinth.com/v2/project/removed');
		expect(state('Modrinth')).toMatchObject({ failingFor: 0, lastFailure: null, lastOkAt: expect.any(Number) });

		answer = () => new Response('', { status: 502 });
		await outboundFetch('https://api.modpacks.ch/public/mod/1');
		answer = () => new Response('', { status: 429 });
		await outboundFetch('https://api.modpacks.ch/public/mod/2');
		expect(state('modpacks.ch (FTB, CurseForge mirror)')).toMatchObject({ failingFor: 2, lastFailure: 'HTTP 429', lastOkAt: null });

		answer = offline('ENOTFOUND');
		await expect(outboundFetch('https://meta.fabricmc.net/v2/versions')).rejects.toThrow('fetch failed');
		expect(state('Fabric')).toMatchObject({ failingFor: 1, lastFailure: 'not found (DNS)' });
		answer = offline('ECONNRESET');
		await expect(outboundFetch('https://meta.fabricmc.net/v2/versions')).rejects.toThrow();
		expect(state('Fabric')?.lastFailure).toBe('dropped the connection');
	});

	it('remember since when a service fails, and start over once it answers', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(1_000_000);
		answer = () => new Response('', { status: 503 });
		await outboundFetch('https://api.adoptium.net/v3/x');
		vi.setSystemTime(1_060_000);
		await outboundFetch('https://api.adoptium.net/v3/x');
		expect(state('Adoptium (Java)')).toMatchObject({ failingFor: 2, failingSince: 1_000_000, lastFailedAt: 1_060_000 });

		answer = () => new Response('{}');
		await outboundFetch('https://api.adoptium.net/v3/x');
		expect(state('Adoptium (Java)')).toMatchObject({ failingFor: 0, failingSince: null, lastFailure: 'HTTP 503', lastOkAt: 1_060_000 });
	});

	it('do not blame a service for a request MineShell cancelled', async () => {
		const stop = new AbortController();
		stop.abort();
		answer = () => {
			throw new DOMException('aborted', 'AbortError');
		};
		await expect(outboundFetch('https://api.modrinth.com/v2/x', { signal: stop.signal })).rejects.toThrow();
		expect(state('Modrinth')).toBeUndefined();
	});

	it('list failing services first, and keep no URL', async () => {
		answer = (url) => new Response('', { status: url.includes('modrinth') ? 200 : 500 });
		await outboundFetch('https://api.modrinth.com/v2/x?token=secret');
		await outboundFetch('https://api.github.com/repos/x?token=secret');
		expect(serviceStates().map((s) => s.name)).toEqual(['GitHub', 'Modrinth']);
		expect(JSON.stringify(serviceStates())).not.toContain('secret');
	});
});
