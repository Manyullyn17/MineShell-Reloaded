import { describe, expect, it } from 'vitest';
import { curseforgeModProvider as mods } from './modpacksch';
import { resolveCurseforgeDownload } from '../packs';
import { useRecordedHttp } from '../../../../tests/helpers/http';

useRecordedHttp('curseforge-mods');

const JEI = '238222';
/** A JEI 1.12.2 file old enough to be on page 2 of its Minecraft version's files. */
const OLD_JEI = '2682936';
/** A JEI file with one required and one optional dependency. */
const JEI_WITH_DEPS = '9038350';

describe('CurseForge mods through the modpacks.ch mirror', () => {
	it('finds mods by name for the instance’s Minecraft version and loader', async () => {
		const hits = await mods.search({ kind: 'mod', term: 'jei', minecraftVersion: '1.12.2', loaders: ['forge'] });
		const jei = hits.find((h) => h.id === JEI);
		// The id doubles as slug: it is what follow-up calls and the mods table use.
		expect(jei).toMatchObject({ source: 'curseforge', slug: JEI, name: 'Just Enough Items (JEI)' });
		// The project record only holds the newest 50 files (all 26.x for JEI);
		// the version check has to look at 1.12.2's own files.
		expect(hits.every((h) => h.gameVersions.includes('1.12.2'))).toBe(true);
	});

	it('browses without a term', async () => {
		const hits = await mods.search({ kind: 'mod', term: '', minecraftVersion: '1.12.2', loaders: ['forge'] });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((h) => h.source === 'curseforge' && h.slug === h.id)).toBe(true);
	});

	it('lists a Minecraft version’s files with everything an install needs', async () => {
		const versions = await mods.listVersions(JEI, { minecraftVersion: '1.12.2', loader: 'forge' });
		expect(versions.length).toBeGreaterThan(10);
		for (const v of versions) {
			expect(v.gameVersions).toContain('1.12.2');
			expect(v.files[0]).toMatchObject({ url: expect.stringMatching(/^https:\/\//), hash: { algo: 'sha1' } });
			expect(v.files[0].filename).toMatch(/\.jar$/);
		}
	});

	it('finds an older file by paging through its Minecraft version', async () => {
		const v = await mods.getVersion(JEI, OLD_JEI, { minecraftVersion: '1.12.2' });
		expect(v.files[0].filename).toBe('jei_1.12.2-4.15.0.268.jar');
		await expect(mods.getVersion(JEI, OLD_JEI)).rejects.toThrow(/not on the modpacks.ch mirror/);
	});

	it('reads dependencies as CurseForge project ids', async () => {
		const v = await mods.getVersion(JEI, JEI_WITH_DEPS);
		expect(v.dependencies).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ projectId: '1689768', type: 'required' }),
				expect.objectContaining({ projectId: '1700987', type: 'optional' })
			])
		);
	});

	it('links the project page', async () => {
		expect(await mods.getProject(JEI)).toMatchObject({
			slug: JEI,
			projectUrl: 'https://www.curseforge.com/minecraft/mc-mods/jei'
		});
	});

	it('resolves an old file of an uploaded pack without an API key', async () => {
		// Previously only the newest 50 files were searched, so most mods of an
		// older pack could not be resolved without a key.
		const file = await resolveCurseforgeDownload(Number(JEI), Number(OLD_JEI), '1.12.2');
		expect(file).toMatchObject({ filename: 'jei_1.12.2-4.15.0.268.jar', sha1: expect.any(String) });
	});
});
