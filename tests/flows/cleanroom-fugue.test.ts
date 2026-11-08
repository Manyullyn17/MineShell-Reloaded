import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectVersion } from '#lib/server/mods/index.js';
import { mcmodInfo, zipBuffer } from '../helpers/fs';

const { applyCleanroomModFixes, pickFugue } = await import('#lib/server/cleanroom.js');
const { curseforgeModProvider, listInstanceMods, modrinthProvider } = await import('#lib/server/mods/index.js');
const { db } = await import('#lib/server/db/index.js');
const { instanceMods, mods, settings } = await import('#lib/server/db/schema.js');
const { eq } = await import('drizzle-orm');
const { installingDependency, installMatchingFugue } = await import('#lib/server/moddeps.js');
const { createInstance, tree, waitForTask } = await import('../helpers/instances');

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
		// 0.24.4 needs Cleanroom 0.6.10: checked and passed over; 0.23.7 checked, then installed.
		expect([...downloads].sort()).toEqual(['0.23.7', '0.23.7', '0.24.4']);
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

	it("takes Fugue from CurseForge on a server whose mods come from there, as a CurseForge pack's do", async () => {
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const href = String(input instanceof Request ? input.url : input);
			const release = RELEASES.find(([v]) => href === url(v));
			if (!release) throw new Error(`unexpected fetch ${href}`);
			return new Response(new Uint8Array(fugueJar(release[2], false)));
		}) as typeof fetch;
		const fromModrinth = vi.spyOn(modrinthProvider, 'listVersions');
		vi.spyOn(curseforgeModProvider, 'getProject').mockResolvedValue({
			source: 'curseforge',
			id: '1005815',
			slug: '1005815',
			name: 'Fugue',
			author: null,
			summary: null,
			iconUrl: null,
			downloads: null,
			projectUrl: 'https://www.curseforge.com/minecraft/mc-mods/fugue',
			loaders: ['forge'],
			gameVersions: ['1.12.2']
		});
		vi.spyOn(curseforgeModProvider, 'listVersions').mockResolvedValue(versions().map((v) => ({ ...v, projectId: '1005815' })));

		const instance = await createInstance(
			{ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: '0.5.17-alpha' },
			{
				'mods/jei.jar': zipBuffer({ 'mcmod.info': mcmodInfo('jei', 'Had Enough Items') }),
				'mods/Scalar Legacy-1.0.1.jar': zipBuffer({ 'mcmod.info': mcmodInfo('scalar', 'Scalar Legacy') })
			}
		);
		for (const [slug, file] of [['557549', 'jei.jar'], ['1235372', 'Scalar Legacy-1.0.1.jar']]) {
			const mod = db.insert(mods).values({ source: 'curseforge', slug, name: file }).returning().get();
			db.insert(instanceMods).values({ instanceId: instance.id, modId: mod.id, filePath: `mods/${file}`, installedAt: 1, fromPack: true }).run();
		}

		const result = await applyCleanroomModFixes(instance);
		expect(result.failures).toEqual([]);
		expect(result.added).toEqual(['+Fugue-0.23.7.jar']);
		expect(fromModrinth).not.toHaveBeenCalled();
		expect((await listInstanceMods(instance)).find((m) => m.fileName === '+Fugue-0.23.7.jar')).toMatchObject({ source: 'curseforge', slug: '1005815' });
	});

	it('remembers what each build needs, so a jar is downloaded once', async () => {
		const downloads: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const href = String(input instanceof Request ? input.url : input);
			const release = RELEASES.find(([v]) => href === url(v))!;
			downloads.push(release[0]);
			return new Response(new Uint8Array(fugueJar(release[2], false)));
		}) as typeof fetch;
		// Ids of their own, so no other test's reads count here.
		const fresh = versions().map((v) => ({ ...v, id: `remember-${v.id}` }));
		expect((await pickFugue(fresh, '0.5.17-alpha', false))?.versionNumber).toBe('0.23.7');
		expect(downloads.length).toBeGreaterThan(0);
		downloads.length = 0;
		expect((await pickFugue(fresh, '0.5.17-alpha', false))?.versionNumber).toBe('0.23.7');
		expect(downloads).toEqual([]);
		// Kept in the database, not only in memory: a restart of MineShell does not read them again.
		const kept = db.select().from(settings).where(eq(settings.key, 'fugue-jar:fugue:remember-fugue-0.23.7')).get();
		expect(JSON.parse(kept!.value)).toEqual({ range: '[0.5.14-alpha,)', callsGetUrl: false, java: null });
	});

	it('reads a build again that was kept before its Java was read', async () => {
		// 1.2 kept range and getURL only; a kept row taken as it is would say nothing about Java.
		const downloads: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const href = String(input instanceof Request ? input.url : input);
			downloads.push(href);
			return new Response(new Uint8Array(fugueJar('[0.5.14-alpha,)', false)));
		}) as typeof fetch;
		const fresh = versions().map((v) => ({ ...v, id: `old-${v.id}` }));
		for (const [v, , range] of RELEASES) {
			const value = JSON.stringify({ range, callsGetUrl: false });
			db.insert(settings).values({ key: `fugue-jar:fugue:old-fugue-${v}`, value }).run();
		}
		await pickFugue(fresh, '0.5.17-alpha', false);
		expect(downloads.length).toBeGreaterThan(0);
		const read = RELEASES.find(([v]) => downloads[0] === url(v))![0];
		const kept = db.select().from(settings).where(eq(settings.key, `fugue-jar:fugue:old-fugue-${read}`)).get();
		expect(JSON.parse(kept!.value)).toHaveProperty('java', null);
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

describe("a crash diagnosis' Install a matching Fugue", () => {
	/** Modrinth's Fugue builds, served by fakes; `ids` keep other tests' kept jar reads out. */
	function fakeFugue(ids: string) {
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const href = String(input instanceof Request ? input.url : input);
			const release = RELEASES.find(([v]) => href === url(v));
			if (!release) throw new Error(`unexpected fetch ${href}`);
			return new Response(new Uint8Array(fugueJar(release[2], false)));
		}) as typeof fetch;
		vi.spyOn(modrinthProvider, 'getProject').mockResolvedValue({
			source: 'modrinth', id: 'fugue', slug: 'fugue', name: 'Fugue', author: null, summary: null, iconUrl: null,
			downloads: null, projectUrl: 'https://modrinth.com/mod/fugue', loaders: ['forge'], gameVersions: ['1.12.2']
		});
		vi.spyOn(modrinthProvider, 'listVersions').mockResolvedValue(versions().map((v) => ({ ...v, id: `${ids}-${v.id}` })));
	}

	const cleanroom = (mods: Record<string, Buffer>) =>
		createInstance(
			{ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: '0.5.17-alpha', launchArgs: '-jar cleanroom-0.5.17-alpha.jar nogui' },
			{ 'cleanroom-0.5.17-alpha.jar': zipBuffer({ [`${HACKERY}.class`]: '\u0000setField\u0000' }), ...mods }
		);

	// The diagnosis named Fugue (0.21 on Cleanroom 0.5.17, Quantum Things crashing) and said
	// to install another one, with nothing to press.
	it('installs the build made for the Cleanroom, then disables the one that crashed', async () => {
		fakeFugue('match');
		const instance = await cleanroom({ 'mods/+Fugue-0.21.0.jar': fugueJar('[0.3.20-alpha,)', true) });
		const id = await installMatchingFugue(instance);
		expect(installingDependency(instance.id, 'fugue')).toBe(true);
		expect((await waitForTask(id)).state).toBe('done');
		expect(installingDependency(instance.id, 'fugue')).toBe(false);
		expect(Object.keys(await tree(path.join(instance.path, 'mods'))).sort()).toEqual(['+Fugue-0.21.0.jar.disabled', '+Fugue-0.23.7.jar']);
		expect((await listInstanceMods(instance)).find((m) => m.fileName === '+Fugue-0.23.7.jar')).toMatchObject({ version: '0.23.7', enabled: true });
	});

	it('says to change Cleanroom when the matching build is the one installed, or none fits', async () => {
		fakeFugue('same');
		const instance = await cleanroom({ 'mods/+Fugue-0.23.7.jar': fugueJar('[0.5.14-alpha,)', false) });
		await expect(installMatchingFugue(instance)).rejects.toThrow(/Fugue 0\.23\.7 is installed, and it is the newest build made for Cleanroom 0\.5\.17-alpha: change Cleanroom/);
		const old = await createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: '0.3.0-alpha', launchArgs: '-jar cleanroom-0.3.0-alpha.jar nogui' });
		await expect(installMatchingFugue(old)).rejects.toThrow(/No Fugue build runs on Cleanroom 0\.3\.0-alpha/);
		const forge = await createInstance({ modloader: 'forge', minecraftVersion: '1.12.2', modloaderVersion: '14.23.5.2860' });
		await expect(installMatchingFugue(forge)).rejects.toThrow(/only for Cleanroom/);
	});
});
