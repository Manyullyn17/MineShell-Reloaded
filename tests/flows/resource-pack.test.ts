import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The server resource pack (resourcepacks.ts): catalogs searched for the server's Minecraft
 * version, a file's URL and SHA-1 written to server.properties under the keys that version reads,
 * a typed URL downloaded once for its SHA-1. Catalog answers recorded 2026-11-08 (CurseForge's with
 * the dev MineShell's key: RECORD_HTTP=1 CURSEFORGE_API_KEY=... npx vitest run <this file>).
 */
const key = vi.hoisted(() => ({ valid: true }));
vi.mock('#lib/server/curseforge.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/curseforge.js')>()),
	getCurseforgeApiKey: () => process.env.CURSEFORGE_API_KEY || 'replayed',
	curseforgeKeyConfigured: () => key.valid,
	curseforgeKeyValid: () => key.valid,
	markCurseforgeKeyInvalid: () => {
		throw new Error('CurseForge rejected the key');
	}
}));

const PACK = Buffer.from('a resource pack, as far as a test cares');
const { useRecordedHttp } = await import('../helpers/http');
useRecordedHttp('resource-packs', {
	extra: {
		'https://packs.example.com/pack.zip': () => new Response(PACK, { headers: { 'content-length': String(PACK.length) } }),
		'https://packs.example.com/huge.zip': () => new Response('x', { headers: { 'content-length': String(300 * 1024 * 1024) } }),
		'https://packs.example.com/gone.zip': () => new Response('gone', { status: 404, statusText: 'Not Found' }),
		// The mirror without Fresh Animations for 1.20.6: the API's own list, with no URL.
		'https://api.modpacks.ch/public/mod/453763/versions/1.20.6': () => new Response('{}', { status: 404 })
	}
});

const { removeResourcePack, resourcePackFiles, resourcePackState, searchResourcePacks, setResourcePackOptions, useCatalogPack, useUrlPack } = await import('#lib/server/resourcepacks.js');
const { readProperties } = await import('#lib/server/properties.js');
const { requireInstance } = await import('#lib/server/instances.js');
const { createInstance } = await import('../helpers/instances');

const props = async (dir: string) => (await readProperties(dir)).values;
const server = (minecraftVersion: string, properties = '') =>
	createInstance({ modloader: 'vanilla', minecraftVersion }, { 'server.properties': `motd=hi\n${properties}` });

beforeEach(() => {
	key.valid = true;
});

describe('the catalogs', () => {
	it("searches Modrinth's resource packs for the Minecraft version, most downloaded without a term", async () => {
		const { hits, note } = await searchResourcePacks('modrinth', '', '1.21.1');
		expect(note).toBeNull();
		expect(hits.length).toBe(20);
		expect(hits.find((h) => h.id === 'r4GILswZ')).toMatchObject({ name: 'Faithful 64x', projectUrl: 'https://modrinth.com/resourcepack/faithful-64x' });
		const found = await searchResourcePacks('modrinth', 'fresh animations', '1.21.1');
		expect(found.hits.length).toBeGreaterThan(0);
	});

	it('lists a Modrinth pack’s files for the version, each with its URL and SHA-1', async () => {
		const files = await resourcePackFiles('modrinth', 'r4GILswZ', '1.21.1');
		expect(files.length).toBeGreaterThan(0);
		expect(files[0].url).toMatch(/^https:\/\/cdn\.modrinth\.com\//);
		expect(files[0].sha1).toMatch(/^[0-9a-f]{40}$/);
	});

	it("searches CurseForge's resource packs through its API; without a key it says why not", async () => {
		const { hits } = await searchResourcePacks('curseforge', '', '1.21.1');
		expect(hits.find((h) => h.id === '453763')).toMatchObject({ name: 'Fresh Animations' });
		key.valid = false;
		expect(await searchResourcePacks('curseforge', 'leaves', '1.21.1')).toEqual({ hits: [], note: expect.stringMatching(/needs a CurseForge API key/) });
	});

	it("takes a CurseForge file's URL from the mirror, an opted-out project's too, as the file's own address", async () => {
		const files = await resourcePackFiles('curseforge', '453763', '1.21.1');
		const file = files.find((f) => f.id === '9394023')!;
		expect(file).toMatchObject({ url: 'https://mediafilez.forgecdn.net/files/9394/23/FreshAnimations_v1.11.2_1.20.zip', sha1: 'c0f564f3b9c12762923015eefad53edbdbbd3d96' });
	});

	it('lists a file the mirror does not have with no URL, as the API gives it: never one made up', async () => {
		// Fresh Animations opted out of other sites: the API gives its files no URL.
		const files = await resourcePackFiles('curseforge', '453763', '1.20.6');
		expect(files.length).toBeGreaterThan(0);
		expect(files.every((f) => f.url === null && f.sha1)).toBe(true);
		const instance = await server('1.20.6');
		await expect(useCatalogPack(instance, 'curseforge', '453763', files[0].id)).rejects.toThrow(/gives no download/);
		expect((await props(instance.path))['resource-pack']).toBeUndefined();
	});
});

describe('server.properties', () => {
	it('points players at a catalog file: its URL and SHA-1, a stale id and old-named hash cleared', async () => {
		const instance = await server('1.21.1', 'resource-pack-id=0b6b5d55-0000-0000-0000-000000000000\nresource-pack-hash=old\n');
		const [file] = await resourcePackFiles('modrinth', 'r4GILswZ', '1.21.1');
		const pack = await useCatalogPack(instance, 'modrinth', 'r4GILswZ', file.id);
		expect(pack).toMatchObject({ source: 'modrinth', name: 'Faithful 64x', fileId: file.id, url: file.url });
		const values = await props(instance.path);
		expect(values).toMatchObject({ 'resource-pack': file.url, 'resource-pack-sha1': file.sha1, 'resource-pack-id': '', 'resource-pack-hash': '', motd: 'hi' });
		const state = await resourcePackState(requireInstance(instance.id));
		expect(state).toMatchObject({ supported: true, url: file.url, sha1: file.sha1, required: false, prompt: '', catalog: { name: 'Faithful 64x' } });
		await expect(useCatalogPack(instance, 'modrinth', 'r4GILswZ', 'nope')).rejects.toThrow(/not one of this pack's/);
	});

	it('downloads a typed address once for its SHA-1, under the key the version reads', async () => {
		const sha1 = crypto.createHash('sha1').update(PACK).digest('hex');
		const modern = await server('1.21.1');
		await useUrlPack(modern, 'https://packs.example.com/pack.zip');
		expect(await props(modern.path)).toMatchObject({ 'resource-pack': 'https://packs.example.com/pack.zip', 'resource-pack-sha1': sha1 });
		// 1.8 called it resource-pack-hash; 1.7.10 reads no hash, so nothing is downloaded.
		const old = await server('1.8.9');
		await useUrlPack(old, 'https://packs.example.com/pack.zip');
		expect(await props(old.path)).toMatchObject({ 'resource-pack-hash': sha1 });
		expect((await props(old.path))['resource-pack-sha1']).toBeUndefined();
		const older = await server('1.7.10');
		await useUrlPack(older, 'https://packs.example.com/gone.zip');
		expect(await props(older.path)).toMatchObject({ 'resource-pack': 'https://packs.example.com/gone.zip' });
		await expect(useUrlPack(await server('1.6.4'), 'https://packs.example.com/pack.zip')).rejects.toThrow(/no server resource pack/);
		// What cannot be downloaded or is too big for players' games changes nothing.
		await expect(useUrlPack(modern, 'https://packs.example.com/gone.zip')).rejects.toThrow(/404/);
		await expect(useUrlPack(modern, 'https://packs.example.com/huge.zip')).rejects.toThrow(/larger than 250 MB/);
		await expect(useUrlPack(modern, 'ftp://packs.example.com/pack.zip')).rejects.toThrow(/https/);
		await expect(useUrlPack(modern, 'https://127.0.0.1/pack.zip')).rejects.toThrow(/SHA-1.*Refused/);
		expect((await props(modern.path))['resource-pack']).toBe('https://packs.example.com/pack.zip');
		// Typed by hand after a catalog pack: no longer that pack.
		expect((await resourcePackState(requireInstance(modern.id))).catalog).toBeNull();
	});

	it('saves whether players must take it and their question as JSON text, from 1.17', async () => {
		const instance = await server('1.21.1');
		await setResourcePackOptions(instance, true, '§6Take §lit');
		const values = await props(instance.path);
		expect(values['require-resource-pack']).toBe('true');
		expect(JSON.parse(values['resource-pack-prompt'])).toEqual({ text: '', extra: [{ text: 'Take ', color: 'gold' }, { text: 'it', color: 'gold', bold: true }] });
		expect(await resourcePackState(requireInstance(instance.id))).toMatchObject({ required: true, prompt: '§6Take §lit' });
		await setResourcePackOptions(instance, false, '  ');
		expect(await props(instance.path)).toMatchObject({ 'require-resource-pack': 'false', 'resource-pack-prompt': '' });
		await expect(setResourcePackOptions(await server('1.16.5'), true, '')).rejects.toThrow(/no such settings/);
		expect(await resourcePackState(await server('1.16.5'))).toMatchObject({ required: null, prompt: null });
	});

	it('stops offering the pack', async () => {
		const instance = await server('1.21.1');
		await useUrlPack(instance, 'https://packs.example.com/pack.zip');
		await removeResourcePack(requireInstance(instance.id));
		expect(await props(instance.path)).toMatchObject({ 'resource-pack': '', 'resource-pack-sha1': '' });
		expect(await resourcePackState(requireInstance(instance.id))).toMatchObject({ url: '', catalog: null });
	});
});
