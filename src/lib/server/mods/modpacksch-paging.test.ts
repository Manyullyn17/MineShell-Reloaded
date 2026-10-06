import { afterEach, describe, expect, it } from 'vitest';
import { curseforgeProvider } from './modpacksch';

const offline = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = offline;
});

/** The mirror's CurseForge browse list: 120 packs, 50 to a page, "No packs." past the end. */
function serveBrowse() {
	const asked: string[] = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url = new URL(String(input));
		asked.push(url.pathname);
		const page = Number(/\/featured\/(\d+)$/.exec(url.pathname)?.[1] ?? 1);
		const packs = Array.from({ length: Math.max(0, Math.min(50, 120 - (page - 1) * 50)) }, (_, i) => ({
			id: (page - 1) * 50 + i + 1,
			name: `Pack ${(page - 1) * 50 + i + 1}`
		}));
		if (!packs.length) return Response.json({ status: 'error', message: 'No packs.' }, { status: 404 });
		return Response.json({ packs, page: String(page), pages: 3, status: 'success' });
	}) as typeof fetch;
	return asked;
}

const ids = (hits: { id: string }[]) => hits.map((h) => Number(h.id));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('modpacks.ch browse paging', () => {
	it('cuts our 20-pack pages out of its 50-pack pages', async () => {
		serveBrowse();
		expect(ids(await curseforgeProvider.search({ term: '', kind: 'modpack', limit: 20, page: 1 }))).toEqual(range(1, 20));
		// Page 2 used to ask the mirror for its page 2: packs 21-50 were never shown.
		expect(ids(await curseforgeProvider.search({ term: '', kind: 'modpack', limit: 20, page: 2 }))).toEqual(range(21, 40));
	});

	it('joins two mirror pages when ours spans them', async () => {
		const asked = serveBrowse();
		expect(ids(await curseforgeProvider.search({ term: '', kind: 'modpack', limit: 20, page: 3 }))).toEqual(range(41, 60));
		expect(asked).toEqual(['/public/curseforge/browse/featured', '/public/curseforge/browse/featured/2']);
	});

	it('answers an empty page past the end instead of failing', async () => {
		serveBrowse();
		expect(ids(await curseforgeProvider.search({ term: '', kind: 'modpack', limit: 20, page: 6 }))).toEqual(range(101, 120));
		expect(await curseforgeProvider.search({ term: '', kind: 'modpack', limit: 20, page: 8 })).toEqual([]);
	});
});
