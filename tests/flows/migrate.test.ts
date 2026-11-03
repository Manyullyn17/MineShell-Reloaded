import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Modloader } from '#lib/server/modloaders.js';
import type { ModProvider, ProjectVersion } from '#lib/server/mods/index.js';

/**
 * Moving a server to another Minecraft version and loader (migrate.ts), end
 * to end on a Forge 1.20.1 server with mods of its own. The mod platform and
 * the loader installer are fakes; every move, restore and record is real.
 */

// Chunky has a NeoForge 1.21.1 build that needs Lib; CorgiLib is Forge 1.20.1 only.
const BUILDS: Record<string, Record<string, { version: string; requires?: string[] }>> = {
	chunky: { 'forge 1.20.1': { version: '1.0' }, 'neoforge 1.21.1': { version: '1.2', requires: ['lib'] } },
	corgilib: { 'forge 1.20.1': { version: '2.0' } },
	lib: { 'neoforge 1.21.1': { version: '3.0' } },
	// Data packs (Modrinth's loader "datapack"): one with a build for every version, one with
	// the same build for 1.20.1 and 1.19.2, one only for 1.20.1, one whose new build fails to download.
	breeze: { 'datapack 1.20.1': { version: '1.0' }, 'datapack 1.21.1': { version: '1.1' }, 'datapack 1.19.2': { version: '0.9' } },
	towers: { 'datapack 1.20.1': { version: '2.0' }, 'datapack 1.19.2': { version: '2.0' } },
	oldonly: { 'datapack 1.20.1': { version: '1.0' } },
	broken: { 'datapack 1.20.1': { version: '1.0' }, 'datapack 1.21.1': { version: '1.1' } }
};
const NAMES: Record<string, string> = { chunky: 'Chunky', corgilib: 'CorgiLib', lib: 'Lib', breeze: 'More Breeze', towers: 'Towers', oldonly: 'Old Only', broken: 'Broken' };
const fileOf = (slug: string, version: string, loader?: string) => `${slug}-${version}${loader === 'datapack' ? '.zip' : '.jar'}`;
const fakeModrinth: Partial<ModProvider> = {
	getProject: async (slug: string) => ({
		source: 'modrinth', id: slug, slug, name: NAMES[slug], author: null, summary: null,
		iconUrl: null, downloads: 0, projectUrl: null, loaders: [], gameVersions: []
	}),
	listVersions: async (slug: string, filter?: { minecraftVersion?: string; loader?: string }): Promise<ProjectVersion[]> => {
		const build = BUILDS[slug]?.[`${filter?.loader} ${filter?.minecraftVersion}`];
		if (!build) return [];
		return [{
			id: `${slug}-${build.version}`, projectId: slug, name: build.version, versionNumber: build.version, channel: 'release',
			datePublished: '2026-01-01T00:00:00Z', gameVersions: [filter!.minecraftVersion!], loaders: [filter!.loader!], changelog: null,
			files: [{ filename: fileOf(slug, build.version, filter?.loader), url: `https://mods.test/${slug}-${build.version}.jar`, primary: true, hash: null, size: null }],
			dependencies: (build.requires ?? []).map((projectId) => ({ projectId, versionId: null, name: NAMES[projectId], type: 'required' as const }))
		}];
	}
};
vi.mock('#lib/server/mods/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/mods/index.js')>();
	return { ...actual, getModProvider: (id: string) => (id === 'modrinth' ? (fakeModrinth as ModProvider) : actual.getModProvider(id)) };
});

const { applyMigration, planMigration } = await import('#lib/server/migrate.js');
const { LOADERS } = await import('#lib/server/modloaders.js');
const { listInstanceMods, recordInstanceMod, upsertMod } = await import('#lib/server/mods/index.js');
const { db } = await import('#lib/server/db/index.js');
const { instanceMods } = await import('#lib/server/db/schema.js');
const { eq } = await import('drizzle-orm');
const { restartMineShell, runAndDieAtMove, hangForever } = await import('../helpers/crash');
const { addJava, clearJava, createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');

const served: Record<string, () => Response> = {};
for (const [slug, builds] of Object.entries(BUILDS)) {
	for (const b of Object.values(builds)) served[`https://mods.test/${slug}-${b.version}.jar`] = () => new Response(`${slug} ${b.version}`);
}
served['https://mods.test/broken-1.1.jar'] = () => new Response('gone', { status: 404 });
useRecordedHttp('none', { extra: served });

const TARGET = { minecraft: '1.21.1', loader: 'neoforge' as const, loaderVersion: '21.1.72' };

/** Forge 1.20.1 with two Modrinth mods and a jar MineShell cannot look up. */
async function forgeServer() {
	const instance = await createInstance(
		{ modloader: 'forge', minecraftVersion: '1.20.1', modloaderVersion: '47.2.0', launchArgs: '@user_jvm_args.txt @libraries/net/minecraftforge/forge/47.2.0/unix_args.txt nogui' },
		{
			'libraries/net/minecraftforge/forge/47.2.0/unix_args.txt': 'forge args',
			'user_jvm_args.txt': '# jvm',
			'run.sh': 'forge run',
			'mods/chunky-1.0.jar': 'chunky 1.0',
			'mods/corgilib-2.0.jar': 'corgilib 2.0',
			'mods/homemade.jar': 'homemade',
			'config/chunky.json': 'my config',
			'world/level.dat': 'my world',
			'server.properties': 'motd=Mine\n'
		}
	);
	for (const [slug, file, version] of [['chunky', 'chunky-1.0.jar', '1.0'], ['corgilib', 'corgilib-2.0.jar', '2.0']]) {
		const modId = upsertMod({ source: 'modrinth', slug, name: NAMES[slug] });
		recordInstanceMod({ instanceId: instance.id, modId, version, versionId: `${slug}-${version}`, filePath: `mods/${file}`, hash: null, hashAlgo: null, fromPack: false });
	}
	return reload(instance.id);
}

/** Data packs in its world: three from the mod browser at their 1.20.1 build, one put there by hand. */
async function withDatapacks(instance: Awaited<ReturnType<typeof forgeServer>>, slugs = ['breeze', 'towers', 'oldonly']) {
	const { instanceDatapacks } = await import('#lib/server/db/schema.js');
	const dir = path.join(instance.path, 'world/datapacks');
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, 'handmade.zip'), 'handmade');
	for (const slug of slugs) {
		const version = BUILDS[slug]['datapack 1.20.1'].version;
		const fileName = fileOf(slug, version, 'datapack');
		await fs.writeFile(path.join(dir, fileName), `${slug} ${version}`);
		db.insert(instanceDatapacks)
			.values({ instanceId: instance.id, source: 'modrinth', projectId: slug, slug, name: NAMES[slug], projectUrl: null, iconUrl: null, version, versionId: `${slug}-${version}`, fileName, hash: 'x', installedAt: 1 })
			.run();
	}
	return instance;
}
const packsIn = async (root: string, world: string) => (await fs.readdir(path.join(root, world, 'datapacks')).catch(() => [] as string[])).sort();

const rowsOf = (id: string) =>
	db.select().from(instanceMods).where(eq(instanceMods.instanceId, id)).all().map((r) => ({ filePath: r.filePath, enabled: r.enabled, version: r.version })).sort((a, b) => a.filePath.localeCompare(b.filePath));

describe('moving a server to another Minecraft version and loader', () => {
	let install: MockInstance<Modloader['install']>;
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(17);
		addJava(21);
		install = vi.spyOn(LOADERS.neoforge, 'install').mockImplementation(async (ctx) => {
			// The Forge install has been moved aside by now.
			expect(await fs.readdir(ctx.dir)).not.toContain('libraries');
			await fs.mkdir(path.join(ctx.dir, 'libraries/net/neoforged'), { recursive: true });
			await fs.writeFile(path.join(ctx.dir, 'libraries/net/neoforged/unix_args.txt'), `neoforge ${ctx.loaderVersion} for ${ctx.minecraftVersion}`);
			return { launchArgs: '@libraries/net/neoforged/unix_args.txt nogui', loaderVersion: ctx.loaderVersion! };
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it('previews what happens to every mod, touching nothing', async () => {
		const instance = await forgeServer();
		const before = await tree(instance.path);
		const plan = await planMigration(instance, TARGET);
		expect(plan.minecraftChange).toBe(true);
		expect(plan.requiredJava).toBe(21);
		const byName = Object.fromEntries(plan.mods.map((m) => [m.name, m]));
		expect(byName.Chunky).toMatchObject({ action: 'update', from: '1.0', to: '1.2' });
		expect(byName.CorgiLib).toMatchObject({ action: 'disable', reason: 'No build for NeoForge 1.21.1.' });
		expect(byName.homemade).toMatchObject({ action: 'disable', reason: expect.stringMatching(/cannot tell/) });
		expect(plan.dependencies.install).toMatchObject([{ name: 'Lib', versionNumber: '3.0', neededBy: ['Chunky'] }]);
		expect(await tree(instance.path)).toEqual(before);
	});

	it('moves the loader and the mods, disabling what has no build, and keeps configs and the world', async () => {
		const instance = await forgeServer();
		await expect(applyMigration(instance, TARGET, { confirmMinecraftChange: false })).rejects.toThrow(/Confirm/);

		const task = await waitForTask(await applyMigration(instance, TARGET, { confirmMinecraftChange: true }));
		expect(task.state).toBe('done');
		expect(install.mock.calls[0][0]).toMatchObject({ minecraftVersion: '1.21.1', loaderVersion: '21.1.72', javaPath: '/fake/jvm/java-21/bin/java' });
		expect(await tree(instance.path)).toEqual({
			'libraries/net/neoforged/unix_args.txt': 'neoforge 21.1.72 for 1.21.1',
			'mods/chunky-1.2.jar': 'chunky 1.2',
			'mods/lib-3.0.jar': 'lib 3.0',
			'mods/corgilib-2.0.jar.disabled': 'corgilib 2.0',
			'mods/homemade.jar.disabled': 'homemade',
			'config/chunky.json': 'my config',
			'world/level.dat': 'my world',
			'server.properties': 'motd=Mine\n'
		});
		expect(reload(instance.id)).toMatchObject({
			minecraftVersion: '1.21.1',
			modloader: 'neoforge',
			modloaderVersion: '21.1.72',
			launchArgs: '@libraries/net/neoforged/unix_args.txt nogui',
			status: 'ready'
		});
		expect(reload(instance.id).statusMessage).toMatch(/Disabled 2 mods with no build/);
		const mods = Object.fromEntries((await listInstanceMods(reload(instance.id))).map((m) => [m.name, m]));
		expect(mods.Chunky).toMatchObject({ version: '1.2', enabled: true });
		expect(mods.CorgiLib).toMatchObject({ version: '2.0', enabled: false, fileName: 'corgilib-2.0.jar.disabled' });
		expect(await fs.readdir(path.join(instance.path, '.mineshell')).catch(() => [])).toEqual([]);
	});

	it("moves the world's data packs to their builds for the target, leaving the rest as they are", async () => {
		const instance = await withDatapacks(await forgeServer());
		const plan = await planMigration(instance, TARGET);
		expect(plan.datapacks.map((d) => [d.name, d.action, d.to])).toEqual([
			['More Breeze', 'update', '1.1'],
			['handmade', 'stay', null],
			['Old Only', 'stay', null],
			['Towers', 'stay', null]
		]);
		expect(plan.datapacks.find((d) => d.name === 'handmade')?.reason).toMatch(/mod browser/);
		const task = await waitForTask(await applyMigration(instance, TARGET, { confirmMinecraftChange: true }));
		expect(task.state).toBe('done');
		expect(await packsIn(instance.path, 'world')).toEqual(['breeze-1.1.zip', 'handmade.zip', 'oldonly-1.0.zip', 'towers-2.0.zip']);
		expect(await fs.readFile(path.join(instance.path, 'world/datapacks/breeze-1.1.zip'), 'utf8')).toBe('breeze 1.1');
	});

	it('keeps the old build of a data pack whose new one fails to download, and says so', async () => {
		const instance = await withDatapacks(await forgeServer(), ['broken']);
		const task = await waitForTask(await applyMigration(instance, TARGET, { confirmMinecraftChange: true }));
		expect(task.state).toBe('done');
		expect(reload(instance.id)).toMatchObject({ minecraftVersion: '1.21.1', status: 'ready', statusMessage: expect.stringMatching(/Data pack Broken was not moved/) });
		expect(await packsIn(instance.path, 'world')).toEqual(['broken-1.0.zip', 'handmade.zip']);
	});

	it('puts everything back, records included, when the loader install fails', async () => {
		const instance = await forgeServer();
		const before = { files: await tree(instance.path), rows: rowsOf(instance.id) };
		// A half-finished install leaves a loader file behind, which the rollback must remove.
		install.mockImplementation(async (ctx) => {
			await fs.writeFile(path.join(ctx.dir, 'neoforge-21.1.72-installer.jar.log'), 'partial');
			throw new Error('Download failed (404)');
		});
		const task = await waitForTask(await applyMigration(instance, TARGET, { confirmMinecraftChange: true }));
		expect(task.state).toBe('failed');
		expect(await tree(instance.path)).toEqual(before.files);
		expect(rowsOf(instance.id)).toEqual(before.rows);
		expect(reload(instance.id)).toMatchObject({ minecraftVersion: '1.20.1', modloader: 'forge', status: 'ready' });
		expect(reload(instance.id).statusMessage).toMatch(/put back/);
	});

	it('leaves pack servers to their pack, and refuses a move to what runs already', async () => {
		const instance = await forgeServer();
		await expect(planMigration(instance, { minecraft: '1.20.1', loader: 'forge', loaderVersion: '47.2.0' })).rejects.toThrow(/runs already/);
		const pack = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1', packSource: 'modrinth', packProjectId: 'p' });
		await expect(planMigration(pack, { minecraft: '1.21.1', loader: 'fabric', loaderVersion: null })).rejects.toThrow(/Modpack version/);
	});

	// Going down was refused outright ("only moves servers up"). Minecraft does not support it,
	// but MineShell leaves it possible: a warning, and by default a new world for the older version.
	describe('to an older Minecraft', () => {
		const OLDER = { minecraft: '1.19.2', loader: 'forge' as const, loaderVersion: '43.3.0' };
		const levelName = async (root: string) => (await fs.readFile(path.join(root, 'server.properties'), 'utf8')).match(/^level-name=(.*)$/m)?.[1] ?? 'world';
		beforeEach(() => {
			vi.spyOn(LOADERS.forge, 'install').mockImplementation(async (ctx) => {
				await fs.mkdir(path.join(ctx.dir, 'libraries/net/minecraftforge/forge', ctx.loaderVersion!), { recursive: true });
				await fs.writeFile(path.join(ctx.dir, 'libraries/net/minecraftforge/forge', ctx.loaderVersion!, 'unix_args.txt'), `forge ${ctx.loaderVersion}`);
				return { launchArgs: `@libraries/net/minecraftforge/forge/${ctx.loaderVersion}/unix_args.txt nogui`, loaderVersion: ctx.loaderVersion! };
			});
		});

		it('starts a new world for it, the old one kept beside it as last run on the newer version', async () => {
			const { listWorlds } = await import('#lib/server/worlds.js');
			const instance = await forgeServer();
			const plan = await planMigration(instance, OLDER);
			expect(plan).toMatchObject({ minecraftChange: true, downgrade: true });
			const task = await waitForTask(await applyMigration(instance, OLDER, { confirmMinecraftChange: true, newWorld: true }));
			expect(task.state).toBe('done');
			expect(reload(instance.id)).toMatchObject({ minecraftVersion: '1.19.2', modloaderVersion: '43.3.0', status: 'ready' });
			const active = await levelName(instance.path);
			expect(active).not.toBe('world');
			expect(await fs.readFile(path.join(instance.path, 'world/level.dat'), 'utf8')).toBe('my world');
			const worlds = await listWorlds(reload(instance.id));
			expect(worlds.find((w) => w.folder === active)).toMatchObject({ active: true, name: 'New world for 1.19.2' });
			// Switching back to it asks first, as for any world a newer Minecraft opened.
			expect(worlds.find((w) => w.folder === 'world')).toMatchObject({ active: false, lastRun: { minecraftVersion: '1.20.1' } });
		});

		it("gives the new world the data packs with a build for it, and leaves the old world's as they were", async () => {
			const instance = await withDatapacks(await forgeServer());
			const task = await waitForTask(await applyMigration(instance, OLDER, { confirmMinecraftChange: true, newWorld: true }));
			expect(task.state).toBe('done');
			const active = await levelName(instance.path);
			expect(await packsIn(instance.path, active)).toEqual(['breeze-0.9.zip', 'towers-2.0.zip']);
			expect(await packsIn(instance.path, 'world')).toEqual(['breeze-1.0.zip', 'handmade.zip', 'oldonly-1.0.zip', 'towers-2.0.zip']);
		});

		it('keeps the world when asked to, opened by the older version as it is', async () => {
			const instance = await forgeServer();
			const task = await waitForTask(await applyMigration(instance, OLDER, { confirmMinecraftChange: true, newWorld: false }));
			expect(task.state).toBe('done');
			expect(await levelName(instance.path)).toBe('world');
			expect(reload(instance.id).minecraftVersion).toBe('1.19.2');
		});

		it('puts the old world back as the active one when the move fails', async () => {
			const instance = await forgeServer();
			vi.spyOn(LOADERS.forge, 'install').mockRejectedValue(new Error('Download failed (404)'));
			const task = await waitForTask(await applyMigration(instance, OLDER, { confirmMinecraftChange: true, newWorld: true }));
			expect(task.state).toBe('failed');
			expect(reload(instance.id).minecraftVersion).toBe('1.20.1');
			expect(await levelName(instance.path)).toBe('world');
			const { listWorlds } = await import('#lib/server/worlds.js');
			expect((await listWorlds(reload(instance.id))).map((w) => w.folder)).toEqual(['world']);
		});
	});

	it('moves to another loader on the same Minecraft version without asking about the world', async () => {
		const instance = await forgeServer();
		const plan = await planMigration(instance, { minecraft: '1.20.1', loader: 'neoforge', loaderVersion: '47.1.106' });
		expect(plan.minecraftChange).toBe(false);
	});

	describe('when MineShell stops part-way', () => {
		it('puts everything back wherever it stopped', async () => {
			let stops = 0;
			for (let n = 1; ; n++) {
				const instance = await forgeServer();
				const before = { files: await tree(instance.path), rows: rowsOf(instance.id) };
				const outcome = await runAndDieAtMove(instance.path, n, () => applyMigration(reload(instance.id), TARGET, { confirmMinecraftChange: true }));
				if (outcome === 'finished') break;
				stops++;
				const [recovered] = (await restartMineShell()).filter((o) => o.instanceId === instance.id);
				expect(recovered?.kind, `stopped at move ${n}`).toBe('migrate');
				expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before.files);
				expect(rowsOf(instance.id), `stopped at move ${n}`).toEqual(before.rows);
				expect(await fs.readdir(path.join(instance.path, '.mineshell'))).not.toContainEqual(expect.stringMatching(/^migrate-/));
				expect(reload(instance.id)).toMatchObject({ minecraftVersion: '1.20.1', modloader: 'forge', status: 'ready' });
			}
			// Disabling two jars, replacing one and moving three loader entries aside.
			expect(stops).toBeGreaterThanOrEqual(6);
		});

		it('puts everything back when it stops during the loader install', async () => {
			const instance = await forgeServer();
			const before = await tree(instance.path);
			let reached!: () => void;
			const installing = new Promise<void>((resolve) => (reached = resolve));
			install.mockImplementation(async () => {
				reached();
				return hangForever();
			});
			await applyMigration(instance, TARGET, { confirmMinecraftChange: true });
			await installing;
			await restartMineShell();
			expect(await tree(instance.path)).toEqual(before);
			expect(reload(instance.id)).toMatchObject({ minecraftVersion: '1.20.1', modloader: 'forge', status: 'ready' });
		});
	});
});
