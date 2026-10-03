import { describe, expect, it } from 'vitest';
import { describePack } from './preview';
import { packFromFileList } from './index';
import { useRecordedHttp } from '../../../../tests/helpers/http';

const mrVersion = (projectId: string, dependencies: { project_id: string; dependency_type: string }[] = []) => ({
	id: `${projectId}-v`,
	project_id: projectId,
	name: '1.0',
	version_number: '1.0',
	version_type: 'release',
	date_published: '2026-01-01T00:00:00Z',
	game_versions: ['1.20.1'],
	loaders: ['fabric'],
	changelog: null,
	files: [],
	dependencies: dependencies.map((d) => ({ ...d, version_id: null, file_name: null }))
});

const mrProject = (id: string, title: string, environment: string[]) => ({
	id,
	slug: id.toLowerCase(),
	title,
	description: '',
	icon_url: null,
	downloads: 1,
	loaders: ['fabric'],
	game_versions: ['1.20.1'],
	team: 't',
	environment
});

useRecordedHttp('none', {
	extra: {
		// The CurseForge mirror lists sha1, so the lookup has to ask by sha1.
		'https://api.modrinth.com/v2/version_files': (init) =>
			JSON.parse(String(init?.body)).algorithm !== 'sha1'
				? Response.json({})
				: Response.json({
					aaa1: mrVersion('ZOOM'),
					bbb1: mrVersion('HUD'),
					ccc1: mrVersion('CONTENT', [{ project_id: 'HUD', dependency_type: 'required' }])
				}),
		[`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(['ZOOM', 'HUD', 'CONTENT']))}`]: () =>
			Response.json([
				mrProject('ZOOM', 'Zoomify', ['client_only']),
				mrProject('HUD', 'Hud Lib', ['client_only']),
				mrProject('CONTENT', 'Content Mod', ['client_and_server'])
			])
	}
});

describe('describePack', () => {
	it('lists the mods with client-only ones first, unless another mod needs them', async () => {
		const pack = packFromFileList({
			name: 'P',
			version: '1',
			minecraftVersion: '1.20.1',
			modloader: 'fabric',
			modloaderVersion: null,
			files: [
				{ path: 'mods/', name: 'content.jar', url: 'https://x/c', sha1: 'ccc1' },
				{ path: 'mods/', name: 'zoomify.jar', url: 'https://x/z', sha1: 'aaa1' },
				{ path: 'mods/', name: 'hudlib.jar', url: 'https://x/h', sha1: 'bbb1' },
				{ path: 'mods/', name: 'unknown-mod.jar', url: 'https://x/u', sha1: 'ddd1' },
				{ path: 'mods/', name: 'shipped-off.jar.disabled', url: 'https://x/o', sha1: 'eee1' },
				{ path: 'config/', name: 'x.cfg', url: 'https://x/x' }
			]
		});
		const preview = await describePack(pack);
		expect(preview.mods.map((m) => [m.name, m.clientOnly !== null, m.neededBy])).toEqual([
			['Hud Lib', true, ['Content Mod']],
			['Zoomify', true, []],
			['Content Mod', false, []],
			['shipped-off', false, []],
			['unknown-mod', false, []]
		]);
		expect(preview.mods.find((m) => m.name === 'shipped-off')).toMatchObject({ packDisabled: true });
		expect(preview.mods.find((m) => m.name === 'Content Mod')).toMatchObject({ packDisabled: false });
		expect(preview.mods[1]).toMatchObject({ target: 'mods/zoomify.jar', fileName: 'zoomify.jar' });
		expect(preview.otherFiles).toBe(1);
	});
});
