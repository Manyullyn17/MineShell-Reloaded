import { describe, expect, it } from 'vitest';
import { useRecordedHttp } from '../../../../tests/helpers/http';
import { projectIdIn, withProjectById } from './projectid';
import type { ProjectKind } from './types';

const detail = (id: number, name: string, website: string) => () =>
	Response.json({ status: 'success', id, name, type: 'release', authors: [], art: [], versions: [], links: [{ id: -1, name: 'Website', link: website, type: 'website' }] });

useRecordedHttp('none', {
	extra: {
		'https://api.modpacks.ch/public/curseforge/411966': detail(411966, 'MeatballCraft, Dimensional Ascension', 'https://www.curseforge.com/minecraft/modpacks/meatballcraft'),
		'https://api.modpacks.ch/public/curseforge/238222': detail(238222, 'Just Enough Items (JEI)', 'https://www.curseforge.com/minecraft/mc-mods/jei')
	}
});

const { curseforgeProvider } = await import('./modpacksch');

type Hit = { id: string; kind?: ProjectKind };
const hit = (id: string, kind?: ProjectKind): Hit => ({ id, kind });

describe('a project id typed into a search', () => {
	it('is read per catalog: digits for CurseForge and FTB, eight letters and digits for Modrinth', () => {
		expect(projectIdIn('curseforge', ' 411966 ')).toBe('411966');
		expect(projectIdIn('ftb', '79')).toBe('79');
		expect(projectIdIn('curseforge', 'meatballcraft')).toBeNull();
		expect(projectIdIn('modrinth', 'KwWsINvD')).toBe('KwWsINvD');
		expect(projectIdIn('modrinth', 'sodium')).toBeNull();
		expect(projectIdIn('modrinth', '411966')).toBeNull();
	});

	// CurseForge's search stopped matching MeatballCraft (November 2026); its id still finds it.
	it('puts the project it names first, once, beside what the search found', async () => {
		const found = await withProjectById({ source: 'curseforge', term: '411966', kind: 'modpack', lookup: async (id) => hit(id, 'modpack'), search: async () => [hit('1672484'), hit('411966')] });
		expect(found.map((h) => h.id)).toEqual(['411966', '1672484']);
	});

	it('leaves out a project of another kind, and looks nothing up past the first page or for a name', async () => {
		const asked: string[] = [];
		const lookup = async (id: string) => (asked.push(id), hit(id, 'mod'));
		const search = async () => [hit('1')];
		expect(await withProjectById({ source: 'curseforge', term: '238222', kind: 'modpack', lookup, search })).toEqual([hit('1')]);
		expect(await withProjectById({ source: 'curseforge', term: '238222', page: 2, kind: 'mod', lookup, search })).toEqual([hit('1')]);
		expect(await withProjectById({ source: 'curseforge', term: 'jei', kind: 'mod', lookup, search })).toEqual([hit('1')]);
		expect(asked).toEqual(['238222']);
	});

	it('keeps either answer when the other fails', async () => {
		const down = async (): Promise<Hit[]> => {
			throw new Error('search down');
		};
		expect(await withProjectById({ source: 'ftb', term: '79', kind: 'modpack', lookup: async (id) => hit(id, 'modpack'), search: down })).toEqual([hit('79', 'modpack')]);
		const missing = async (): Promise<Hit> => {
			throw new Error('404');
		};
		expect(await withProjectById({ source: 'ftb', term: '79', kind: 'modpack', lookup: missing, search: async () => [hit('5')] })).toEqual([hit('5')]);
		await expect(withProjectById({ source: 'ftb', term: '79', kind: 'modpack', lookup: missing, search: down })).rejects.toThrow('search down');
	});

	// The mirror answers packs and mods alike by id; only the page address tells them apart.
	it('knows from the mirror whether a CurseForge id is a pack or a mod', async () => {
		expect(await curseforgeProvider.getProject('411966')).toMatchObject({ name: 'MeatballCraft, Dimensional Ascension', kind: 'modpack' });
		expect(await curseforgeProvider.getProject('238222')).toMatchObject({ kind: 'mod' });
	});
});
