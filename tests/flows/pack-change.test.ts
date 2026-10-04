import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Modloader } from '#lib/server/modloaders.js';
import type { ParsedPack } from '#lib/server/packs/index.js';
import type { ModProvider, ProjectVersion } from '#lib/server/mods/index.js';

/**
 * Pack version change, end to end on an instance installed by the real pack
 * install flow. The pack host, mod platform and loader installer are fakes;
 * everything that moves, restores or records state is real.
 */

const PACKS: Record<string, () => ParsedPack> = {};
vi.mock('#lib/server/packs/resolve.js', () => ({
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
// Lets a test make re-tracking mods (after the change is committed) fail.
const syncControl = vi.hoisted(() => ({ fail: false }));
vi.mock('#lib/server/mods/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/mods/index.js')>();
	return {
		...actual,
		getModProvider: (id: string) => (id === 'modrinth' ? (fakeModrinth as ModProvider) : actual.getModProvider(id)),
		syncMods: (...args: Parameters<typeof actual.syncMods>) =>
			syncControl.fail ? Promise.reject(new Error('mod index broke')) : actual.syncMods(...args)
	};
});

const { createFromPack } = await import('#lib/server/instances.js');
const { planPackChange, applyPackChange } = await import('#lib/server/packchange.js');
const { recoverInterruptedOperations } = await import('#lib/server/recovery.js');
const { listOperations } = await import('#lib/server/operations.js');
const { db } = await import('#lib/server/db/index.js');
const { operations } = await import('#lib/server/db/schema.js');
const { hangForever, restartMineShell, runAndDieAtMove } = await import('../helpers/crash');
const { LOADERS } = await import('#lib/server/modloaders.js');
const { packFromFileList } = await import('#lib/server/packs/index.js');
const { recordInstanceMod, setModEnabled, upsertMod } = await import('#lib/server/mods/index.js');
const { patchProperties, readProperties } = await import('#lib/server/properties.js');
const { serverInstances } = await import('#lib/server/db/schema.js');
const { eq } = await import('drizzle-orm');
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
			name: 'Test Pack', version: `Test Pack ${id}.zip`, minecraftVersion: minecraft, modloader: 'fabric', modloaderVersion: null,
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
	afterEach(() => {
		vi.restoreAllMocks();
		syncControl.fail = false;
	});

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
		// Named after the version people see (minus .zip), not the provider's id.
		expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-Test_Pack_v1$/);
		expect(await tree(path.join(instance.path, 'old-configs', stamp))).toEqual({
			'config/pack.cfg': 'edited by me',
			'scripts/old.zs': 'old script'
		});
		expect((await readProperties(instance.path)).values.motd).toBe('My server');
		expect(install).toHaveBeenCalledTimes(1); // only the original install; same loader and Minecraft
		expect(reload(instance.id)).toMatchObject({ packVersionId: 'v2', packVersionName: 'Test Pack v2.zip', status: 'ready', statusMessage: null });
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
	/** Apply v2 with the given step broken; everything must be exactly as before. */
	async function expectRestoredAfter(breakStep: () => void) {
		const instance = await installedAndUsed();
		const before = { files: await tree(instance.path), row: reload(instance.id) };
		breakStep();
		const task = await waitForTask(await applyPackChange(instance, 'v2', { updateMods: ['chunky-1.0.jar'], confirmMinecraftChange: false }));
		expect(task.state).toBe('failed');
		expect(await tree(instance.path)).toEqual(before.files);
		const after = reload(instance.id);
		expect(after).toMatchObject({ packVersionId: before.row.packVersionId, packVersionName: before.row.packVersionName, status: 'ready' });
		expect(after.statusMessage).toMatch(/restored/);
	}

	it('restores everything when moving configs aside fails part-way', async () => {
		await expectRestoredAfter(() => {
			// config/ moves fine, scripts/ fails: config must come back, scripts must survive.
			const realRename = fs.rename.bind(fs);
			let moves = 0;
			vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
				if (String(to).includes('/old-configs/') && ++moves === 2) throw new Error('EIO: disk hiccup');
				return realRename(from, to);
			});
		});
	});

	it('restores everything when unpacking the new overrides fails', async () => {
		await expectRestoredAfter(() => {
			const realWrite = fs.writeFile.bind(fs);
			vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, opts) => {
				if (String(file).endsWith('scripts/new.zs')) throw new Error('ENOSPC: no space left');
				return realWrite(file, data, opts);
			});
		});
	});

	it('restores everything when downloading a mod update fails', async () => {
		const original = served['https://mods.test/chunky-1.1.jar'];
		try {
			await expectRestoredAfter(() => {
				served['https://mods.test/chunky-1.1.jar'] = () => new Response('gone', { status: 404 });
			});
		} finally {
			served['https://mods.test/chunky-1.1.jar'] = original;
		}
	});

	it('keeps a committed change and reports problems that happen after it', async () => {
		const instance = await installedAndUsed();
		syncControl.fail = true;
		const task = await waitForTask(await applyPackChange(instance, 'v2', { updateMods: [], confirmMinecraftChange: false }));
		expect(task.state).toBe('done');
		expect(await tree(instance.path, /^(\.mineshell|old-configs)\//)).toMatchObject({ 'mods/c.jar': 'c.jar from v2', 'config/pack.cfg': 'v2' });
		const row = reload(instance.id);
		expect(row).toMatchObject({ packVersionId: 'v2', status: 'ready' });
		expect(row.statusMessage).toMatch(/Re-tracking mods failed: mod index broke/);
	});

	it('disables client-only mods the new version adds, not ones the user turned back on', async () => {
		const clientJar = (id: string) => zipBuffer({ 'fabric.mod.json': JSON.stringify({ id, environment: 'client' }) });
		for (const [id, files] of [['c1', ['old-client.jar']], ['c2', ['old-client.jar', 'new-client.jar']]] as const) {
			PACKS[id] = () => {
				for (const f of files) served[`https://packs.test/${id}/${f}`] = () => new Response(new Uint8Array(clientJar(f)));
				return packFromFileList({
					name: 'Test Pack', version: id, minecraftVersion: '1.20.1', modloader: 'fabric', modloaderVersion: null,
					files: files.map((f) => ({ path: 'mods/', name: f, url: `https://packs.test/${id}/${f}` }))
				});
			};
		}
		const { instance, taskId } = await createFromPack('Client Mods', PACKS.c1(), { source: 'modrinth', projectId: 'p', versionId: 'c1' });
		await waitForTask(taskId);
		expect(Object.keys(await tree(instance.path))).toContain('mods/old-client.jar.disabled');
		// The server needs it after all.
		await setModEnabled(reload(instance.id), 'old-client.jar.disabled', true);

		await planPackChange(reload(instance.id), 'c2');
		const task = await waitForTask(await applyPackChange(reload(instance.id), 'c2', { updateMods: [], confirmMinecraftChange: false }));
		expect(task.state).toBe('done');
		const files = Object.keys(await tree(instance.path));
		expect(files).toEqual(expect.arrayContaining(['mods/old-client.jar', 'mods/new-client.jar.disabled']));
		expect(reload(instance.id).statusMessage).toMatch(/Disabled 1 client-only mod \(new-client\)/);
	});

	describe('when MineShell stops part-way', () => {
		for (const [versionId, what] of [['v2', 'without a loader change'], ['v3', 'with a Minecraft and loader change']] as const) {
			it(`puts everything back wherever it stopped, ${what}`, async () => {
				let stops = 0;
				for (let n = 1; ; n++) {
					const instance = await installedAndUsed();
					const before = { files: await tree(instance.path), row: reload(instance.id) };
					const outcome = await runAndDieAtMove(instance.path, n, () =>
						applyPackChange(reload(instance.id), versionId, { updateMods: ['chunky-1.0.jar'], confirmMinecraftChange: true })
					);
					if (outcome === 'finished') break;
					stops++;

					const [recovered] = (await restartMineShell()).filter((o) => o.instanceId === instance.id);
					expect(recovered?.kind, `stopped at move ${n}`).toBe('pack-change');
					expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before.files);
					expect(await fs.readdir(path.join(instance.path, '.mineshell'))).not.toContainEqual(expect.stringMatching(/^pack-change-/));
					const after = reload(instance.id);
					expect(after).toMatchObject({
						minecraftVersion: before.row.minecraftVersion,
						packVersionId: 'v1',
						launchArgs: before.row.launchArgs,
						status: 'ready'
					});
					expect(after.statusMessage).toMatch(/stopped while changing the pack version/);
					expect(listOperations().some((op) => op.instanceId === instance.id)).toBe(false);
				}
				// Configs, pack mods, the user's mod update (and the loader): each move was a place to stop.
				expect(stops).toBeGreaterThanOrEqual(5);
			});
		}

		it('puts everything back when it stops during the loader install', async () => {
			const instance = await installedAndUsed();
			const before = { files: await tree(instance.path), row: reload(instance.id) };
			let started!: () => void;
			const installing = new Promise<void>((resolve) => (started = resolve));
			install.mockImplementation(async (ctx) => {
				await fs.writeFile(path.join(ctx.dir, 'server.jar'), 'half-installed');
				started();
				return hangForever();
			});
			await applyPackChange(instance, 'v3', { updateMods: [], confirmMinecraftChange: true });
			await installing;
			await restartMineShell();
			expect(await tree(instance.path)).toEqual(before.files);
			expect(reload(instance.id)).toMatchObject({ minecraftVersion: '1.20.1', launchArgs: before.row.launchArgs, status: 'ready' });
		});

		it('leaves an operation this process is running alone', async () => {
			const instance = await installedAndUsed();
			install.mockImplementation(hangForever);
			await applyPackChange(instance, 'v3', { updateMods: [], confirmMinecraftChange: true });
			expect((await recoverInterruptedOperations()).filter((o) => o.instanceId === instance.id)).toEqual([]);
			expect(reload(instance.id).status).toBe('provisioning');
			expect(listOperations().some((op) => op.instanceId === instance.id)).toBe(true);
			db.delete(operations).run();
		});
	});

	describe('the world and its data packs', () => {
		// w1 -> w2: Terralith renamed (2.5 -> 2.6), shared.zip changed, a per-world
		// config changed, and one new per-world config.
		definePack('w1', '1.20.1', ['a.jar'], {
			'config/pack.cfg': 'w1',
			'world/datapacks/terralith-2.5.zip': 'terralith 2.5',
			'world/datapacks/shared.zip': 'shared v1',
			'world/serverconfig/tuning.toml': 'pack default v1'
		});
		definePack('w2', '1.20.1', ['a.jar'], {
			'config/pack.cfg': 'w2',
			'world/datapacks/terralith-2.6.zip': 'terralith 2.6',
			'world/datapacks/shared.zip': 'shared v2',
			'world/serverconfig/tuning.toml': 'pack default v2',
			'world/serverconfig/new.toml': 'new in w2'
		});

		/** w1 installed, then played: a world, a data pack of the user's own, a tuned per-world config. */
		async function playedWorld(world = 'world') {
			const { instance, taskId } = await createFromPack('World', PACKS.w1(), { source: 'modrinth', projectId: 'p', versionId: 'w1' });
			expect((await waitForTask(taskId)).state).toBe('done');
			const dir = instance.path;
			if (world !== 'world') {
				await fs.rename(path.join(dir, 'world'), path.join(dir, world));
				await patchProperties(dir, { 'level-name': world });
			}
			await fs.writeFile(path.join(dir, world, 'level.dat'), 'my world');
			await fs.writeFile(path.join(dir, world, 'datapacks', 'mine.zip'), 'my own data pack');
			await fs.writeFile(path.join(dir, world, 'serverconfig', 'tuning.toml'), 'tuned by me');
			return reload(instance.id);
		}

		it('records which data packs a pack installs', async () => {
			const instance = await playedWorld();
			expect(JSON.parse(instance.packDatapacks!)).toEqual(['shared.zip', 'terralith-2.5.zip']);
		});

		it('never moves the world, and syncs only the pack’s data packs', async () => {
			// Previously "world" counted as a pack config folder: the whole world went
			// to old-configs and the pack's world folder replaced it.
			const instance = await playedWorld();
			const plan = await planPackChange(instance, 'w2');
			expect(plan.configs).toEqual(['config']);
			expect(plan.world).toMatchObject({
				folder: 'world',
				datapacks: { add: ['terralith-2.6.zip'], update: ['shared.zip'], remove: ['terralith-2.5.zip'] },
				previousUnknown: false,
				newFiles: ['serverconfig/new.toml']
			});

			const task = await waitForTask(await applyPackChange(instance, 'w2', { updateMods: [], confirmMinecraftChange: false }));
			expect(task.state).toBe('done');
			const files = await tree(instance.path);
			expect(files).toMatchObject({
				'world/level.dat': 'my world',
				'world/datapacks/mine.zip': 'my own data pack',
				'world/datapacks/shared.zip': 'shared v2',
				'world/datapacks/terralith-2.6.zip': 'terralith 2.6',
				// Per-world config the user tuned stays; the new one is added.
				'world/serverconfig/tuning.toml': 'tuned by me',
				'world/serverconfig/new.toml': 'new in w2'
			});
			expect(files['world/datapacks/terralith-2.5.zip']).toBeUndefined();
			const kept = Object.keys(files).find((f) => f.startsWith('old-configs/') && f.endsWith('/world/datapacks/terralith-2.5.zip'));
			expect(kept).toBeDefined();
			expect(JSON.parse(reload(instance.id).packDatapacks!)).toEqual(['shared.zip', 'terralith-2.6.zip']);
		});

		it('puts the pack’s world files into the world the server actually uses', async () => {
			const instance = await playedWorld('survival');
			const plan = await planPackChange(instance, 'w2');
			expect(plan.world.folder).toBe('survival');
			expect(plan.configs).toEqual(['config']);
			await waitForTask(await applyPackChange(instance, 'w2', { updateMods: [], confirmMinecraftChange: false }));

			const files = await tree(instance.path);
			expect(files).toMatchObject({
				'survival/level.dat': 'my world',
				'survival/datapacks/mine.zip': 'my own data pack',
				'survival/datapacks/terralith-2.6.zip': 'terralith 2.6',
				'survival/serverconfig/new.toml': 'new in w2'
			});
			expect(Object.keys(files).some((f) => f.startsWith('world/'))).toBe(false);
		});

		it('puts the world back wherever the change stops', async () => {
			let stops = 0;
			for (let n = 1; ; n++) {
				const instance = await playedWorld();
				const before = await tree(instance.path);
				const outcome = await runAndDieAtMove(instance.path, n, () =>
					applyPackChange(reload(instance.id), 'w2', { updateMods: [], confirmMinecraftChange: false })
				);
				if (outcome === 'finished') break;
				stops++;
				await restartMineShell();
				expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before);
				expect(JSON.parse(reload(instance.id).packDatapacks!)).toEqual(['shared.zip', 'terralith-2.5.zip']);
			}
			expect(stops).toBeGreaterThanOrEqual(3);
		});

		it('works out an older install’s data packs from its version, or removes none', async () => {
			// Installed before MineShell recorded them: the installed version is read instead.
			const instance = await playedWorld();
			db.update(serverInstances).set({ packDatapacks: null }).where(eq(serverInstances.id, instance.id)).run();
			const plan = await planPackChange(reload(instance.id), 'w2');
			expect(plan.world).toMatchObject({ previousUnknown: false, datapacks: { remove: ['terralith-2.5.zip'] } });

			// And when that version cannot be read either, nothing is removed and the preview says so.
			db.update(serverInstances).set({ packDatapacks: null, packVersionId: 'gone' }).where(eq(serverInstances.id, instance.id)).run();
			const unknown = await planPackChange(reload(instance.id), 'w2');
			expect(unknown.world).toMatchObject({ previousUnknown: true, datapacks: { remove: [] } });
		});

		it('installs a pack’s world files into the world its server.properties names', async () => {
			// The pack sets level-name but kept its files under world/.
			definePack('named', '1.20.1', ['a.jar'], {
				'server.properties': 'level-name=adventure\nmotd=Named\n',
				'world/datapacks/quests.zip': 'quests'
			});
			const { instance, taskId } = await createFromPack('Named', PACKS.named(), { source: 'modrinth', projectId: 'p', versionId: 'named' });
			await waitForTask(taskId);
			const files = await tree(instance.path);
			expect(files['adventure/datapacks/quests.zip']).toBe('quests');
			expect(Object.keys(files).some((f) => f.startsWith('world/'))).toBe(false);
			expect(JSON.parse(reload(instance.id).packDatapacks!)).toEqual(['quests.zip']);
		});
	});
});
