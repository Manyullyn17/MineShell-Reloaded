import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Modloader } from '#lib/server/modloaders.js';
import type { ParsedPack } from '#lib/server/packs/index.js';
import type { ModProvider, ProjectVersion } from '#lib/server/mods/index.js';

/**
 * Rolling a pack version change back (packrollback.ts), end to end on an
 * instance installed by the real pack install flow. The pack host, mod
 * platform and loader installer are fakes (the same as pack-change.test.ts);
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
const { recordInstanceMod, upsertMod } = await import('#lib/server/mods/index.js');
const { latestMergeReport } = await import('#lib/server/configmerge.js');
const { db } = await import('#lib/server/db/index.js');
const { serverInstances } = await import('#lib/server/db/schema.js');
const { eq } = await import('drizzle-orm');
const { applyPackChange, prepareUploadedPack } = await import('#lib/server/packchange.js');
const { rollbackInfo, rollbackPackChange } = await import('#lib/server/packrollback.js');
const { listSnapshots } = await import('#lib/server/snapshots.js');
const { listTasks } = await import('#lib/server/tasks.js');
const { LOADERS } = await import('#lib/server/modloaders.js');
const { packFromFileList } = await import('#lib/server/packs/index.js');
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
	for (const [slug, file, version] of [['chunky', 'chunky-1.0.jar', '1.0'], ['corgilib', 'corgilib-2.0.jar', '2.0']]) {
		await fs.writeFile(path.join(dir, 'mods', file), `${slug} ${version}`);
		const modId = upsertMod({ source: 'modrinth', slug, name: slug === 'chunky' ? 'Chunky' : 'CorgiLib' });
		recordInstanceMod({ instanceId: instance.id, modId, version, versionId: `${slug}-${version}`, filePath: `mods/${file}`, hash: null, hashAlgo: null, fromPack: false });
	}
	await fs.writeFile(path.join(dir, 'mods/homemade.jar'), 'homemade');
	return reload(instance.id);
}

/** v1 installed and used, then updated to `to` (Chunky updated along), and used again. */
async function updated(to = 'v2', opts: { snapshot?: boolean } = {}) {
	const instance = await installedAndUsed();
	const task = await waitForTask(
		await applyPackChange(instance, to, { updateMods: ['chunky-1.0.jar'], confirmMinecraftChange: true, snapshot: opts.snapshot })
	);
	expect(task.state).toBe('done');
	return reload(instance.id);
}

const oldConfigFolders = async (dir: string) => (await fs.readdir(path.join(dir, 'old-configs')).catch(() => [] as string[])).sort();

describe('rolling a pack change back', () => {
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

	it('goes back to the version before with the configs exactly as they were, and leaves the user’s mods', async () => {
		const instance = await updated();
		// The update merged pack.cfg (both changed it) and wrote its report.
		expect(await latestMergeReport(instance.path)).not.toBeNull();
		// Used after the update: an edit, and a mod of the user's own.
		await fs.writeFile(path.join(instance.path, 'config/pack.cfg'), 'edited after the update');
		await fs.writeFile(path.join(instance.path, 'mods/extra.jar'), 'extra');
		recordInstanceMod({
			instanceId: instance.id, modId: upsertMod({ source: 'modrinth', slug: 'extra', name: 'Extra' }), version: '1', versionId: 'extra-1',
			filePath: 'mods/extra.jar', hash: null, hashAlgo: null, fromPack: false
		});

		const info = await rollbackInfo(instance);
		expect(info).toMatchObject({
			from: { versionName: 'Test Pack v1.zip', minecraft: '1.20.1' },
			to: { versionName: 'Test Pack v2.zip' },
			blocked: null,
			needsWorld: false,
			snapshot: null,
			keptMods: { updatedByChange: ['Chunky'], changedSince: ['Extra'] },
			missingConfigs: []
		});
		const [updateStamp] = await oldConfigFolders(instance.path);

		const task = await waitForTask(await rollbackPackChange(instance, { restoreWorld: false, snapshot: false }));
		expect(task.state).toBe('done');
		const files = await tree(instance.path, /^(\.mineshell|old-configs)\//);
		expect(files).toMatchObject({
			// Pack mods are v1's again.
			'mods/a.jar': 'a.jar from v1',
			'mods/b.jar': 'b.jar from v1',
			'mods/bundled.jar': 'bundled v1',
			// The user's own mods stay, also the one the update moved to 1.1.
			'mods/chunky-1.1.jar': 'chunky 1.1',
			'mods/corgilib-2.0.jar': 'corgilib 2.0',
			'mods/homemade.jar': 'homemade',
			'mods/extra.jar': 'extra',
			// Exactly as before the update, not merged with anything.
			'config/pack.cfg': 'edited by me',
			'scripts/old.zs': 'old script',
			'world/level.dat': 'my world'
		});
		for (const gone of ['mods/c.jar', 'scripts/new.zs', 'kubejs/x.js']) expect(Object.keys(files)).not.toContain(gone);
		expect(reload(instance.id)).toMatchObject({ packVersionId: 'v1', packVersionName: 'Test Pack v1.zip', status: 'ready' });

		// The update's old-configs stay; the configs as they were until now are in a new one.
		const folders = await oldConfigFolders(instance.path);
		expect(folders).toContain(updateStamp);
		const newer = folders.find((f) => f !== updateStamp && f.endsWith('Test_Pack_v2'))!;
		expect(await tree(path.join(instance.path, 'old-configs', newer))).toEqual({
			'config/pack.cfg': 'edited after the update',
			'kubejs/x.js': 'x',
			'scripts/new.zs': 'new script'
		});
		// The update's merge report describes files no longer there.
		expect(await latestMergeReport(instance.path)).toBeNull();
		expect(task.log.join('\n')).toMatch(/Put back config, scripts as they were before the change/);
		expect(task.log.join('\n')).toMatch(/Removed kubejs, which the change had added/);

		// The rollback is a change of its own, and can be undone in turn.
		expect(await rollbackInfo(reload(instance.id))).toMatchObject({
			from: { versionName: 'Test Pack v2.zip' },
			to: { versionName: 'Test Pack v1.zip' },
			blocked: null
		});
	});

	it('puts everything back when the rollback fails part-way', async () => {
		const instance = await updated();
		const before = await tree(instance.path);
		const realCp = fs.cp;
		// Putting the configs back is the last step that touches files.
		vi.spyOn(fs, 'cp').mockImplementation(async (from, to, o) => {
			if (String(from).includes('old-configs')) throw new Error('disk full');
			return realCp(from, to, o);
		});
		const task = await waitForTask(await rollbackPackChange(instance, { restoreWorld: false, snapshot: false }));
		expect(task.state).toBe('failed');
		expect(await tree(instance.path)).toEqual(before);
		expect(reload(instance.id)).toMatchObject({ packVersionId: 'v2', status: 'ready' });
		// Still the update to roll back.
		expect(await rollbackInfo(reload(instance.id))).toMatchObject({ to: { versionName: 'Test Pack v2.zip' }, blocked: null });
	});

	it('brings the world back from the snapshot taken before the change, keeping the current one', async () => {
		const instance = await updated('v2', { snapshot: true });
		await fs.writeFile(path.join(instance.path, 'world/level.dat'), 'played on v2');
		const info = await rollbackInfo(instance);
		expect(info?.snapshot).toMatchObject({ id: expect.stringContaining('pack-change') });

		const task = await waitForTask(await rollbackPackChange(instance, { restoreWorld: true, snapshot: false }));
		expect(task.state).toBe('done');
		const restore = listTasks().find((t) => t.instanceId === instance.id && t.label.startsWith('Restoring a world snapshot'));
		expect(restore).toBeDefined();
		expect((await waitForTask(restore!.id)).state).toBe('done');
		expect(await fs.readFile(path.join(instance.path, 'world/level.dat'), 'utf8')).toBe('my world');
		// The world played on v2 is a snapshot now.
		const kept = await listSnapshots(instance.path);
		expect(kept.length).toBe(2);
		expect(reload(instance.id)).toMatchObject({ packVersionId: 'v1', status: 'ready' });
	});

	it('needs the world from before when the change moved Minecraft', async () => {
		const without = await updated('v3');
		expect(await rollbackInfo(without)).toMatchObject({ needsWorld: true, blocked: expect.stringMatching(/from 1\.20\.1 to 1\.21\.1/) });
		await expect(rollbackPackChange(without, { restoreWorld: false, snapshot: false })).rejects.toThrow(/does not load/);

		const withSnapshot = await updated('v3', { snapshot: true });
		const info = await rollbackInfo(withSnapshot);
		expect(info).toMatchObject({ needsWorld: true, blocked: null });
		await expect(rollbackPackChange(withSnapshot, { restoreWorld: false, snapshot: false })).rejects.toThrow(/needs the world/);
	});

	it('refuses when the version before cannot be fetched again, or the pack changed unrecorded', async () => {
		const fromFile = await updated();
		db.update(serverInstances).set({ packVersionId: 'v9' }).where(eq(serverInstances.id, fromFile.id)).run();
		expect((await rollbackInfo(reload(fromFile.id)))?.blocked).toMatch(/changed since/);

		// Updated from an uploaded file: there is nothing to fetch the version before from.
		const instance = await updated();
		const versionId = await prepareUploadedPack(instance, zipBuffer({
			'modrinth.index.json': JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '2.5', name: 'Test Pack', files: [], dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.0' } })
		}));
		expect((await waitForTask(await applyPackChange(instance, versionId, { updateMods: [], confirmMinecraftChange: false }))).state).toBe('done');
		await waitForTask(await applyPackChange(reload(instance.id), 'v2', { updateMods: [], confirmMinecraftChange: false }));
		expect((await rollbackInfo(reload(instance.id)))?.blocked).toMatch(/uploaded file/);
	});

	it('has nothing to roll back before any change', async () => {
		const { instance, taskId } = await createFromPack('Fresh', PACKS.v1(), { source: 'modrinth', projectId: 'p', versionId: 'v1' });
		await waitForTask(taskId);
		expect(await rollbackInfo(reload(instance.id))).toBeNull();
		await expect(rollbackPackChange(reload(instance.id), { restoreWorld: false, snapshot: false })).rejects.toThrow(/no pack change/);
	});
});
