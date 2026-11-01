import { afterEach, describe, expect, it, vi } from 'vitest';

const key = vi.hoisted(() => ({ valid: true, markedInvalid: 0 }));
vi.mock('../curseforge', () => ({
	getCurseforgeApiKey: () => 'test-key',
	curseforgeKeyConfigured: () => true,
	curseforgeKeyValid: () => key.valid,
	markCurseforgeKeyInvalid: () => {
		key.valid = false;
		key.markedInvalid++;
	}
}));

const { listVersions } = await import('./curseforge-official');
const { curseforgeProvider } = await import('./curseforge');

const offline = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = offline;
});

/** The official files endpoint: `count` files, newest first, served 50 at a time by `index`. */
function serveFiles(count: number) {
	const asked: string[] = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url = new URL(String(input));
		asked.push(url.search);
		const index = Number(url.searchParams.get('index') ?? 0);
		const size = Number(url.searchParams.get('pageSize') ?? 50);
		const data = Array.from({ length: Math.max(0, Math.min(size, count - index)) }, (_, i) => ({
			id: count - index - i,
			displayName: `Pack ${count - index - i}`,
			fileName: `pack-${count - index - i}.zip`,
			releaseType: 1,
			gameVersions: ['1.20.1']
		}));
		return Response.json({ data, pagination: { index, pageSize: size, resultCount: data.length, totalCount: count } });
	}) as typeof fetch;
	return asked;
}

describe('CurseForge official API', () => {
	it('lists every file of a project, not only the newest 50', async () => {
		const asked = serveFiles(123);
		const versions = await listVersions('1');
		expect(versions).toHaveLength(123);
		expect(versions[0].id).toBe('123');
		expect(versions.at(-1)!.id).toBe('1');
		expect(asked).toHaveLength(3);
	});

	it('stops after one page when there are fewer files', async () => {
		const asked = serveFiles(7);
		expect(await listVersions('1')).toHaveLength(7);
		expect(asked).toHaveLength(1);
	});
});

/** The official API answering every call with `status`, the mirror with one category. */
function serveStatus(status: number) {
	const asked: string[] = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url = new URL(String(input));
		asked.push(url.host);
		if (url.host === 'api.curseforge.com') return new Response(null, { status });
		return Response.json({ tags: [{ id: 1, name: 'From the mirror' }] });
	}) as typeof fetch;
	return asked;
}

describe('CurseForge with a key it stops accepting', () => {
	it('falls back to the mirror and stops asking the official API once it refuses the key', async () => {
		key.valid = true;
		key.markedInvalid = 0;
		const asked = serveStatus(403);
		const groups = await curseforgeProvider.filterGroups!('modpack');
		expect(groups.at(-1)!.options).toEqual([{ value: '1', label: 'From the mirror' }]);
		expect(key.markedInvalid).toBe(1);
		asked.length = 0;
		await curseforgeProvider.filterGroups!('modpack');
		expect(asked).not.toContain('api.curseforge.com');
	});

	it('keeps the key when the official API is only down', async () => {
		key.valid = true;
		key.markedInvalid = 0;
		serveStatus(503);
		await curseforgeProvider.filterGroups!('modpack');
		expect(key.markedInvalid).toBe(0);
		expect(key.valid).toBe(true);
	});
});
