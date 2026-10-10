import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectVersion } from '#lib/server/mods/index.js';
import { mcmodInfo, zipBuffer } from '../helpers/fs';

const { applyCleanroomModFixes } = await import('#lib/server/cleanroom.js');
const { listInstanceMods, modrinthProvider } = await import('#lib/server/mods/index.js');
const { createInstance, tree } = await import('../helpers/instances');

const HACKERY = 'com/cleanroommc/hackery/ReflectionHackery';

function fugueJar(range: string, callsGetUrl: boolean): Buffer {
	return zipBuffer({
		'mcmod.info': mcmodInfo('fugue', 'Fugue'),
		'com/cleanroommc/fugue/Fugue.class': `\u0000required-after:cleanroom@${range};\u0000`,
		'com/cleanroommc/fugue/transformer/universal/URLClassLoaderTransformer.class': callsGetUrl ? `\u0000${HACKERY}\u0000getURL\u0000` : '\u0000getURL\u0000'
	});
}

/** Modrinth's Fugue builds (ranges as their jars declare them), served by a fake fetch. */
const RELEASES: [string, string, string][] = [
	['0.24.4', '2026-09-14', '[0.6.10-alpha,)'],
	['0.23.7', '2026-07-10', '[0.5.14-alpha,)'],
	['0.23.4', '2026-04-01', '[0.5.7-alpha,)']
];
const url = (v: string) => `https://cdn.modrinth.com/data/fugue/+Fugue-${v}.jar`;

function versions(): ProjectVersion[] {
	return RELEASES.map(([versionNumber, datePublished]) => ({
		id: `fugue-${versionNumber}`,
		projectId: 'fugue',
		name: versionNumber,
		versionNumber,
		channel: 'release',
		datePublished,
		gameVersions: ['1.12.2'],
		loaders: ['forge'],
		changelog: null,
		files: [{ url: url(versionNumber), filename: `+Fugue-${versionNumber}.jar`, primary: true, hash: null, size: null }],
		dependencies: []
	}));
}

const offline = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = offline;
	vi.restoreAllMocks();
});

describe('Cleanroom fixes and Fugue', () => {
	it("replaces a pack's Fugue that does not run on the server's Cleanroom with one that does", async () => {
		const downloads: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const href = String(input instanceof Request ? input.url : input);
			const release = RELEASES.find(([v]) => href === url(v));
			if (!release) throw new Error(`unexpected fetch ${href}`);
			downloads.push(release[0]);
			return new Response(new Uint8Array(fugueJar(release[2], false)));
		}) as typeof fetch;
		vi.spyOn(modrinthProvider, 'getProject').mockResolvedValue({
			source: 'modrinth',
			id: 'fugue',
			slug: 'fugue',
			name: 'Fugue',
			author: null,
			summary: null,
			iconUrl: null,
			downloads: null,
			projectUrl: 'https://modrinth.com/mod/fugue',
			loaders: ['forge'],
			gameVersions: ['1.12.2']
		});
		vi.spyOn(modrinthProvider, 'listVersions').mockResolvedValue(versions());

		const instance = await createInstance(
			{ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: '0.5.17-alpha', launchArgs: '-jar cleanroom-0.5.17-alpha.jar nogui' },
			{
				'cleanroom-0.5.17-alpha.jar': zipBuffer({ [`${HACKERY}.class`]: '\u0000setField\u0000' }),
				// What MeatballCraft 0.18.4-hotfix6 ships.
				'mods/+Fugue-0.21.0.jar': fugueJar('[0.3.20-alpha,)', true),
				'mods/Scalar Legacy-1.0.1.jar': zipBuffer({ 'mcmod.info': mcmodInfo('scalar', 'Scalar Legacy') })
			}
		);

		const result = await applyCleanroomModFixes(instance);
		expect(result.failures).toEqual([]);
		// 0.24.4 needs Cleanroom 0.6.10: checked and passed over.
		expect(downloads.slice(0, 2)).toEqual(['0.24.4', '0.23.7']);
		expect(result.added).toEqual(['+Fugue-0.23.7.jar']);
		expect(result.disabled).toEqual(['+Fugue-0.21.0.jar']);
		expect(Object.keys(await tree(path.join(instance.path, 'mods'))).sort()).toEqual([
			'+Fugue-0.21.0.jar.disabled',
			'+Fugue-0.23.7.jar',
			'Scalar Legacy-1.0.1.jar'
		]);
		expect((await listInstanceMods(instance)).find((m) => m.fileName === '+Fugue-0.23.7.jar')).toMatchObject({ version: '0.23.7', enabled: true });

		// Run again: nothing left to do.
		const again = await applyCleanroomModFixes(instance);
		expect([again.added, again.disabled, again.failures]).toEqual([[], [], []]);
	});

	it('keeps the old Fugue when no replacement can be had', async () => {
		vi.spyOn(modrinthProvider, 'getProject').mockRejectedValue(new Error('Modrinth is down'));
		vi.spyOn(modrinthProvider, 'listVersions').mockRejectedValue(new Error('Modrinth is down'));
		const instance = await createInstance(
			{ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: '0.5.17-alpha' },
			{
				'mods/+Fugue-0.21.0.jar': fugueJar('[0.3.20-alpha,)', true),
				'mods/Scalar Legacy-1.0.1.jar': zipBuffer({ 'mcmod.info': mcmodInfo('scalar', 'Scalar Legacy') })
			}
		);
		const result = await applyCleanroomModFixes(instance);
		expect(result.failures).toEqual([expect.stringMatching(/^Could not replace \+Fugue-0\.21\.0\.jar.*Modrinth is down/)]);
		expect(await fs.readdir(path.join(instance.path, 'mods'))).toContain('+Fugue-0.21.0.jar');
	});
});
