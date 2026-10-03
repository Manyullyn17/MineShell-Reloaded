import { describe, expect, it } from 'vitest';
import { curseforgeProvider as mirror } from './modpacksch';
import { useRecordedHttp } from '../../../../tests/helpers/http';

useRecordedHttp('modpacksch');

// MeatballCraft, the pack behind several of this session's bugs.
const MEATBALLCRAFT = '411966';
const VERSION = '8665629';

describe('modpacks.ch CurseForge mirror', () => {
	it('gives the exact install target of a pack version', async () => {
		const v = await mirror.getVersion(MEATBALLCRAFT, VERSION);
		expect(v.gameVersions).toEqual(['1.12.2']);
		expect(v.loaders).toEqual(['forge']);
		expect(v.loaderVersions).toEqual({ forge: '14.23.5.2860' });
	});

	it('keeps each file’s folder, including the root overrides.zip', async () => {
		const v = await mirror.getVersion(MEATBALLCRAFT, VERSION);
		expect(v.files.find((f) => f.filename === 'overrides.zip')?.path).toBe('./');
		const jars = v.files.filter((f) => f.filename.endsWith('.jar'));
		expect(jars.length).toBeGreaterThan(300);
		// The mirror is not consistent about a leading "./" ("mods/" next to "./");
		// packFromFileList normalises both.
		expect(jars.every((f) => /^(\.\/)?mods\/$/.test(f.path ?? ''))).toBe(true);
	});

	it('drops client-only files from a server install', async () => {
		const v = await mirror.getVersion(MEATBALLCRAFT, VERSION);
		// Flagged clientonly in this version's file list.
		expect(v.files.some((f) => f.filename.startsWith('[MC-1.12.2] Key Binding Patch'))).toBe(false);
	});

	it('lists versions with every tagged game version (why install uses the detail)', async () => {
		const versions = await mirror.listVersions(MEATBALLCRAFT);
		const v = versions.find((x) => x.id === VERSION)!;
		expect(v.gameVersions).toEqual(expect.arrayContaining(['1.12', '1.12.2']));
	});
});
