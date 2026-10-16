import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModProvider, ProjectVersion } from '#lib/server/mods/index.js';

// The download writes a stand-in file; no network in tests.
vi.mock('#lib/server/download.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/download.js')>()),
	downloadFile: vi.fn(async (url: string, destination: string) => {
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, `zip from ${url}`);
	})
}));

const listed = vi.hoisted(() => ({ versions: [] as unknown[] }));
vi.mock('#lib/server/mods/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/mods/index.js')>();
	const fake = { id: 'modrinth', listVersions: async () => listed.versions } as unknown as ModProvider;
	return { ...actual, getModProvider: (id: string) => (id === 'modrinth' ? fake : actual.getModProvider(id)) };
});

const { installDatapackVersion, listDatapacks } = await import('#lib/server/mods/datapacks.js');
const { applyDatapackUpdates, checkDatapackUpdates } = await import('#lib/server/modupdates.js');
const { listSnapshots } = await import('#lib/server/snapshots.js');
const { writeNbt } = await import('#lib/server/nbt.js');
const { zipBuffer } = await import('../helpers/fs');
const { createInstance, systemdStopped, waitForTask } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');
const { invalidateUnitState } = await import('#lib/server/systemd.js');

const PROJECT = { id: 'bxa7yl3z', slug: 'terralith', name: 'Terralith', projectUrl: null, iconUrl: null };

const version = (n: string, date: string, extra: Partial<ProjectVersion> = {}): ProjectVersion =>
	({
		id: `v-${n}`,
		projectId: PROJECT.id,
		name: n,
		versionNumber: n,
		channel: 'release',
		datePublished: date,
		gameVersions: ['1.21.1'],
		loaders: ['datapack'],
		changelog: null,
		files: [{ filename: `Terralith_v${n}.zip`, url: `https://cdn.example/${n}.zip`, primary: true, size: 10, hash: { algo: 'sha512', value: `hash-${n}` } }],
		dependencies: [],
		...extra
	}) as ProjectVersion;

/** level.dat with these packs enabled, as the world records the ones it loaded. */
function levelDat(enabled: string[]): Buffer {
	const compound = (value: [string, unknown][]) => ({ type: 'compound' as const, value });
	return writeNbt({
		name: '',
		gzipped: true,
		root: compound([
			['Data', compound([['DataPacks', compound([['Enabled', { type: 'list', itemType: 'string', value: enabled.map((value) => ({ type: 'string', value })) }]])]])]
		])
	} as Parameters<typeof writeNbt>[0]);
}

describe('data pack updates', () => {
	beforeEach(() => {
		systemdStopped();
		listed.versions = [version('2.6.0', '2026-10-02T00:00:00Z'), version('2.6.1-beta', '2026-10-03T00:00:00Z', { channel: 'beta' }), version('2.5.8', '2026-10-01T00:00:00Z')];
	});

	it('finds a newer release of a pack from the mod browser and swaps the file', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'world/datapacks/mine.zip': 'hand-added' });
		await installDatapackVersion(instance, 'modrinth', PROJECT, version('2.5.8', '2026-10-01T00:00:00Z'));
		const check = await checkDatapackUpdates(instance);
		// Releases stay on releases; the hand-added pack has nothing to look up.
		expect(check.updates).toEqual([
			{ fileName: 'Terralith_v2.5.8.zip', name: 'Terralith', currentVersion: '2.5.8', targetVersionId: 'v-2.6.0', targetVersion: '2.6.0', channel: 'release', worldgenInUse: false }
		]);
		expect((await waitForTask(await applyDatapackUpdates(instance, [{ fileName: 'Terralith_v2.5.8.zip', versionId: 'v-2.6.0' }], { snapshot: false }))).state).toBe('done');
		const { packs } = await listDatapacks(instance);
		expect(packs.map((p) => [p.fileName, p.version])).toEqual([
			['mine.zip', null],
			['Terralith_v2.6.0.zip', '2.6.0']
		]);
		await expect(applyDatapackUpdates(instance, [{ fileName: 'mine.zip', versionId: 'v-2.6.0' }], { snapshot: false })).rejects.toThrow(/not a data pack MineShell installed/);
	});

	it('updates a world-generation pack the world has loaded only with the server stopped, after a snapshot', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'world/level.dat': levelDat(['vanilla', 'file/Terralith_v2.5.8.zip']) });
		await installDatapackVersion(instance, 'modrinth', PROJECT, version('2.5.8', '2026-10-01T00:00:00Z'));
		// What the download would have brought: a pack with biomes.
		await fs.writeFile(path.join(instance.path, 'world/datapacks/Terralith_v2.5.8.zip'), zipBuffer({ 'pack.mcmeta': '{}', 'data/terralith/worldgen/biome/x.json': '{}' }));
		expect((await checkDatapackUpdates(instance)).updates[0].worldgenInUse).toBe(true);

		invalidateUnitState();
		fakeProcesses((_, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\nMainPID=4321\n' } : {}));
		await expect(applyDatapackUpdates(instance, [{ fileName: 'Terralith_v2.5.8.zip', versionId: 'v-2.6.0' }], { snapshot: true })).rejects.toThrow();

		systemdStopped();
		expect((await waitForTask(await applyDatapackUpdates(instance, [{ fileName: 'Terralith_v2.5.8.zip', versionId: 'v-2.6.0' }], { snapshot: true }))).state).toBe('done');
		expect((await listSnapshots(instance.path)).map((s) => s.reason)).toEqual(['mod-update']);
		expect((await listDatapacks(instance)).packs.map((p) => p.version)).toEqual(['2.6.0']);
	});
});
