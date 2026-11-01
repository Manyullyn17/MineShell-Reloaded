import { describe, expect, it, vi } from 'vitest';
import { useRecordedHttp } from '../../../../tests/helpers/http';

/**
 * CurseForge's official API against its real answers (recorded 2026-11-01 with the key saved in
 * the dev MineShell's Settings). The client was written from the published docs with no key at
 * hand; these pin the field mapping to what api.curseforge.com actually sends. Re-recording needs
 * a key (tests/tools/curseforge-key.mjs); the fixture holds URLs and bodies, never the key.
 */
const recording = process.env.RECORD_HTTP === '1';
const KEY = process.env.CURSEFORGE_API_KEY;

vi.mock('../curseforge', async (importOriginal) => ({
	...(await importOriginal<typeof import('../curseforge')>()),
	getCurseforgeApiKey: () => process.env.CURSEFORGE_API_KEY || 'replayed',
	curseforgeKeyConfigured: () => true,
	curseforgeKeyValid: () => true,
	// A rejected key falls back to the mirror without a word: here it has to fail.
	markCurseforgeKeyInvalid: () => {
		throw new Error('CurseForge rejected the key');
	}
}));

const official = await import('./curseforge-official');
const { curseforgeProvider, curseforgeModProvider } = await import('./curseforge');
const { testCurseforgeApiKey } = await import('../curseforge');

useRecordedHttp('curseforge-official');

const MEATBALLCRAFT = '411966';
/** MeatballCraft 0.18.6.4, a release; 0.18.6.2 before it is a beta. */
const PACK_FILE = '8665629';
const BETA_FILE = '8557163';
const JEI = '238222';

// tests/tools/check-apis.sh without a key: nothing to try, and nothing to record.
describe.skipIf(recording && !KEY)("CurseForge's official API", () => {
	it('accepts the key', async () => {
		expect(await testCurseforgeApiKey(KEY || 'replayed')).toEqual({ ok: true, message: 'CurseForge accepted the key.' });
	});

	it('finds a pack by name, with its author, picture, loader and Minecraft versions', async () => {
		const hits = await official.search({ kind: 'modpack', term: 'meatballcraft' });
		expect(hits.find((h) => h.id === MEATBALLCRAFT)).toMatchObject({
			source: 'curseforge',
			slug: 'meatballcraft',
			name: 'MeatballCraft, Dimensional Ascension',
			author: 'sainagh',
			iconUrl: expect.stringMatching(/^https:\/\/media\.forgecdn\.net\//),
			downloads: expect.any(Number),
			updatedAt: expect.stringMatching(/^20\d\d-/),
			projectUrl: 'https://www.curseforge.com/minecraft/modpacks/meatballcraft',
			loaders: ['forge'],
			gameVersions: expect.arrayContaining(['1.12.2'])
		});
	});

	it("searches mods for a Minecraft version and loader, the mod's own id as its slug", async () => {
		const hits = await curseforgeModProvider.search({ kind: 'mod', term: 'jei', minecraftVersion: '1.12.2', loaders: ['forge'] });
		expect(hits[0]).toMatchObject({ id: JEI, slug: JEI, name: 'Just Enough Items (JEI)', author: 'mezz' });
		expect(hits.every((h) => h.gameVersions.includes('1.12.2'))).toBe(true);
		// Many 1.12 mods' files carry no loader tag (JER, JEI Bees): found for Forge all the same.
		expect(hits.every((h) => h.loaders.length === 0 || h.loaders.includes('forge'))).toBe(true);
		expect(hits.some((h) => h.loaders.length === 0)).toBe(true);
	});

	it("reads a project and its description", async () => {
		expect(await official.getProject(MEATBALLCRAFT)).toMatchObject({ id: MEATBALLCRAFT, name: 'MeatballCraft, Dimensional Ascension' });
		expect(await official.description(MEATBALLCRAFT)).toMatch(/^<.+>/s);
	});

	it("lists every file of a pack across pages, each with its channel, date and tags", async () => {
		const versions = await official.listVersions(MEATBALLCRAFT);
		// 112 files when recorded, 50 a page.
		expect(versions.length).toBeGreaterThanOrEqual(112);
		expect(new Set(versions.map((v) => v.id)).size).toBe(versions.length);
		expect(versions.find((v) => v.id === PACK_FILE)).toMatchObject({
			projectId: MEATBALLCRAFT,
			name: 'Meatballcraft-prerelease-0.18.6.4.zip',
			channel: 'release',
			datePublished: '2026-08-16T21:30:42.46Z',
			// "1.12", "Forge", "1.12.2": the loader taken out of the Minecraft versions.
			gameVersions: ['1.12', '1.12.2'],
			loaders: ['forge']
		});
		expect(versions.find((v) => v.id === BETA_FILE)?.channel).toBe('beta');
	});

	it("reads a file with its changelog", async () => {
		expect(await official.getVersion(MEATBALLCRAFT, PACK_FILE)).toMatchObject({ id: PACK_FILE, changelog: '<p>bug fixes</p>' });
	});

	it("keeps the mirror's install target and files beside the official changelog", async () => {
		// The official tags put "1.12" first: that installed MeatballCraft on Forge 1.12.
		const v = await curseforgeProvider.getVersion(MEATBALLCRAFT, PACK_FILE);
		expect(v.changelog).toBe('<p>bug fixes</p>');
		expect(v.gameVersions).toEqual(['1.12.2']);
		expect(v.loaderVersions).toEqual({ forge: '14.23.5.2860' });
		expect(v.files.length).toBeGreaterThan(300);
	});

	it("offers the pack categories as a filter, not the class they belong to", async () => {
		const [loaders, categories] = await official.filterGroups('modpack');
		expect(loaders.options.map((o) => o.value)).toEqual(['forge', 'fabric', 'quilt', 'neoforge']);
		expect(categories.options.map((o) => o.label)).toEqual(expect.arrayContaining(['Extra Large', 'Small / Light']));
		expect(categories.options.map((o) => o.label)).not.toContain('Modpacks');
	});
});
