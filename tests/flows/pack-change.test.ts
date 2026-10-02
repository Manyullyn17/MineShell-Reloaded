import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Modloader } from '$lib/server/modloaders';
import type { ParsedPack } from '$lib/server/packs';
import type { ModProvider, ProjectVersion } from '$lib/server/mods';

/**
 * Pack version change, end to end on an instance installed by the real pack
 * install flow. The pack host, mod platform and loader installer are fakes;
 * everything that moves, restores or records state is real.
 */

const PACKS: Record<string, () => ParsedPack> = {};
vi.mock('$lib/server/packs/resolve', () => ({
	resolveProviderPack: async (_source: string, _project: string, versionId: string) => ({
		pack: PACKS[versionId](),
		projectName: 'Test Pack'
	})
}));

// A mod platform where Chunky has builds for both Minecraft versions and
// CorgiLib only for 1.20.1.
const BUILDS: Record<string, Record<string, string>> = {
	chunky: { '1.20.1': '1.1', '1.21.1': '1.2' },
	corgilib: { '1.20.1': '2.0' }
};
const fakeModrinth: Partial<ModProvider> = {
	getProject: async (slug: string) => ({
		source: 'modrinth', id: slug, slug, name: slug === 'chunky' ? 'Chunky' : 'CorgiLib', author: null, summary: null,
		iconUrl: null, downloads: 0, projectUrl: null, loaders: ['fabric'], gameVersions: []
	}),
	listVersions: async (slug: string, filter?: { minecraftVersion?: string }): Promise<ProjectVersion[]> => {
		const version = BUILDS[slug]?.[filter?.minecraftVersion ?? ''];
		if (!version) return [];
		return [{
			id: `${slug}-${version}`, projectId: slug, name: version, versionNumber: version, channel: 'release',
			datePublished: '2026-01-01T00:00:00Z', gameVersions: [filter!.minecraftVersion!], loaders: ['fabric'], changelog: null,
			files: [{ filename: `${slug}-${version}.jar`, url: `https://mods.test/${slug}-${version}.jar`, primary: true, hash: null, size: null }],
			dependencies: []
		}];
	}
};
vi.mock('$lib/server/mods', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/mods')>();
	return { ...actual, getProvider: (id: string) => (id === 'modrinth' ? (fakeModrinth as ModProvider) : actual.getProvider(id)) };
});

const { createFromPack } = await import('$lib/server/instances');
const { planPackChange, applyPackChange } = await import('$lib/server/packchange');
const { LOADERS } = await import('$lib/server/modloaders');
const { packFromFileList } = await import('$lib/server/packs');
const { recordInstanceMod, upsertMod } = await import('$lib/server/mods');
const { patchProperties, readProperties } = await import('$lib/server/properties');
const { addJava, clearJava, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');

const served: Record<string, () => Response> = {
	'https://api.modrinth.com/v2/version_files': () => Response.json({})
};
useRecordedHttp('none', { extra: served });
for (const [slug, builds] of Object.entries(BUILDS)) {
	for (const v of Object.values(builds)) served[`https://mods.test/${slug}-${v}.jar`] = () => new Response(`${slug} ${v}`);
}

const sha1 = (text: string) => crypto.createHash('sha1').update(text).digest('hex');

/** A pack version: mods served with sha1 hashes (as the mirror gives them), plus overrides. */
function definePack(id: string, minecraft: string, mods: string[], overrides: Record<string, string>) {
	PACKS[id] = () => {
		for (const m of mods) served[`https://packs.test/${id}/${m}`] = () => new Response(`${m} from ${id}`);
		served[`https://packs.test/${id}/overrides.zip`] = () =>
			new Response(new Uint8Array(zipBuffer(Object.fromEntries(Object.entries(overrides).map(([k, v]) => [`overrides/${k}`, v])))));
		return packFromFileList({
			name: 'Test Pack', version: id, minecraftVersion: minecraft, modloader: 'fabric', modloaderVersion: null,
			files: [
				...mods.map((m) => ({ path: 'mods/', name: m, url: `https://packs.test/${id}/${m}`, sha1: sha1(`${m} from ${id}`) })),
				{ path: './', name: 'overrides.zip', url: `https://packs.test/${id}/overrides.zip` }
			]
		});
	};
}

// a.jar and the bundled jar keep their names from v1 to v2 but change content.
definePack('v1', '1.20.1', ['a.jar', 'b.jar'], { 'config/pack.cfg': 'v1', 'scripts/old.zs': 'old script', 'mods/bundled.jar': 'bundled v1' });
definePack('v2', '1.20.1', ['a.jar', 'c.jar'], { 'config/pack.cfg': 'v2', 'scripts/new.zs': 'new script', 'kubejs/x.js': 'x', 'mods/bundled.jar': 'bundled v2' });
definePack('v3', '1.21.1', ['a.jar'], { 'config/pack.cfg': 'v3' });

let install: MockInstance<Modloader['install']>;

/** Install v1 through the real flow, then use it like a player would. */
async function installedAndUsed() {
	const { instance, taskId } = await createFromPack('Changing', PACKS.v1(), { source: 'modrinth', projectId: 'p', versionId: 'v1' });
	expect((await waitForTask(taskId)).state).toBe('done');
	const dir = instance.path;
	await fs.writeFile(path.join(dir, 'config/pack.cfg'), 'edited by me');
	await fs.mkdir(path.join(dir, 'world'), { recursive: true });
	await fs.writeFile(path.join(dir, 'world/level.dat'), 'my world');
	await patchProperties(dir, { motd: 'My server' });
	for (const [slug, file, version] of [['chunky', 'chunky-1.0.jar', '1.0'], ['corgilib', 'corgilib-2.0.jar', '2.0']]) {
		await fs.writeFile(path.join(dir, 'mods', file), `${slug} ${version}`);
		const modId = upsertMod({ source: 'modrinth', slug, name: slug === 'chunky' ? 'Chunky' : 'CorgiLib' });
		recordInstanceMod({ instanceId: instance.id, modId, version, versionId: `${slug}-${version}`, filePath: `mods/${file}`, hash: null, hashAlgo: null, fromPack: false });
	}
	await fs.writeFile(path.join(dir, 'mods/homemade.jar'), 'homemade');
	return reload(instance.id);
}

describe('changing the pack version', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(17);
		addJava(21);
		install = vi.spyOn(LOADERS.fabric, 'install').mockImplementation(async (ctx) => {
			await fs.writeFile(path.join(ctx.dir, 'server.jar'), `fabric for ${ctx.minecraftVersion}`);
			return { launchArgs: '-jar server.jar nogui', loaderVersion: '0.16.0' };
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it('previews the change without touching anything', async () => {
		const instance = await installedAndUsed();
		const before = await tree(instance.path);
		const plan = await planPackChange(instance, 'v2');
		expect(plan).toMatchObject({ minecraftChange: false, mods: { add: ['c.jar'], update: ['a.jar', 'bundled.jar'], remove: ['b.jar'], keep: 0 } });
		expect(plan.configs).toEqual(['config', 'kubejs', 'scripts']);
		const byName = Object.fromEntries(plan.manual.map((m) => [m.name, m]));
		expect(byName.Chunky).toMatchObject({ status: 'update', currentVersion: '1.0', targetVersion: '1.1', blocking: false });
		expect(byName.CorgiLib).toMatchObject({ status: 'current', blocking: false });
		expect(byName.homemade).toMatchObject({ status: 'unknown', blocking: false });
		expect(await tree(instance.path)).toEqual(before);
	});

	it('updates the pack, keeps old configs and the user’s own mods', async () => {
		const instance = await installedAndUsed();
		// The user switched a pack mod off; it should stay off after the update.
		await fs.rename(path.join(instance.path, 'mods/bundled.jar'), path.join(instance.path, 'mods/bundled.jar.disabled'));
		const task = await waitForTask(await applyPackChange(instance, 'v2', { updateMods: ['chunky-1.0.jar'], confirmMinecraftChange: false }));
		expect(task.state).toBe('done');

		const files = await tree(instance.path, /^(\.mineshell|old-configs)\//);
		expect(files).toMatchObject({
			'mods/a.jar': 'a.jar from v2',
			'mods/bundled.jar.disabled': 'bundled v2',
			'mods/c.jar': 'c.jar from v2',
			'mods/chunky-1.1.jar': 'chunky 1.1',
			'mods/corgilib-2.0.jar': 'corgilib 2.0',
			'mods/homemade.jar': 'homemade',
			'config/pack.cfg': 'v2',
			'scripts/new.zs': 'new script',
			'kubejs/x.js': 'x',
			'world/level.dat': 'my world'
		});
		expect(Object.keys(files)).not.toContain('mods/b.jar');
		expect(Object.keys(files)).not.toContain('mods/bundled.jar');
		expect(Object.keys(files)).not.toContain('mods/chunky-1.0.jar');
		expect(Object.keys(files)).not.toContain('scripts/old.zs');

		// What the user had is kept, whole, in old-configs/<date>-<old version>/.
		const [stamp] = await fs.readdir(path.join(instance.path, 'old-configs'));
		expect(stamp).toMatch(/-v1$/);
		expect(await tree(path.join(instance.path, 'old-configs', stamp))).toEqual({
			'config/pack.cfg': 'edited by me',
			'scripts/old.zs': 'old script'
		});
		expect((await readProperties(instance.path)).values.motd).toBe('My server');
		expect(install).toHaveBeenCalledTimes(1); // only the original install; same loader and Minecraft
		expect(reload(instance.id)).toMatchObject({ packVersionId: 'v2', status: 'ready', statusMessage: null });
	});

	it('needs confirmation to change the Minecraft version, and flags mods that will break', async () => {
		const instance = await installedAndUsed();
		const plan = await planPackChange(instance, 'v3');
		expect(plan).toMatchObject({ minecraftChange: true, loaderChange: true, target: { minecraft: '1.21.1' } });
		const byName = Object.fromEntries(plan.manual.map((m) => [m.name, m]));
		expect(byName.CorgiLib).toMatchObject({ status: 'unavailable', blocking: true });
		expect(byName.homemade).toMatchObject({ status: 'unknown', blocking: true });

		await expect(applyPackChange(instance, 'v3', { updateMods: [], confirmMinecraftChange: false })).rejects.toThrow(/Confirm/);

		const task = await waitForTask(await applyPackChange(instance, 'v3', { updateMods: ['chunky-1.0.jar'], confirmMinecraftChange: true }));
		expect(task.state).toBe('done');
		expect(install.mock.calls.at(-1)![0]).toMatchObject({ minecraftVersion: '1.21.1', javaPath: '/fake/jvm/java-21/bin/java' });
		const row = reload(instance.id);
		expect(row).toMatchObject({ minecraftVersion: '1.21.1', packVersionId: 'v3' });
		expect(row.statusMessage).toMatch(/no compatible version: .*CorgiLib/);
		expect(await tree(instance.path, /^(\.mineshell|old-configs)\//)).toMatchObject({ 'mods/chunky-1.2.jar': 'chunky 1.2', 'server.jar': 'fabric for 1.21.1' });
	});

	it('puts everything back when the change fails part-way', async () => {
		const instance = await installedAndUsed();
		const before = { files: await tree(instance.path), row: reload(instance.id) };
		install.mockImplementation(async (ctx) => {
			await fs.writeFile(path.join(ctx.dir, 'server.jar'), 'half-installed');
			throw new Error('installer crashed');
		});

		const task = await waitForTask(await applyPackChange(instance, 'v3', { updateMods: ['chunky-1.0.jar'], confirmMinecraftChange: true }));
		expect(task.state).toBe('failed');
		expect(await tree(instance.path)).toEqual(before.files);
		const after = reload(instance.id);
		expect(after).toMatchObject({ minecraftVersion: '1.20.1', packVersionId: 'v1', launchArgs: before.row.launchArgs, status: 'ready' });
		expect(after.statusMessage).toMatch(/restored/);
	});
});
