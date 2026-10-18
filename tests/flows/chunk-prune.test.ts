import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyseRegions, applyPrune, planPrune } from '#lib/server/chunkprune.js';
import { NO_CHUNK, UNREADABLE } from '#lib/shared/chunkprune.js';
import { listSnapshots } from '#lib/server/snapshots.js';
import { analysePrunable, pruneAnalysis, pruneChunks, restoreSnapshot, runningPruneAnalysis, worldSpawn, type PruneSettings } from '#lib/server/world.js';
import { writeNbt, type Tag } from '#lib/server/nbt.js';
import type { ServerInstance } from '#lib/server/db/schema.js';
import { createInstance, systemdStopped, tree, waitForTask } from '../helpers/instances';
import { restartMineShell, runAndDieAtMove } from '../helpers/crash';
import { readRegion, writeRegion } from '../helpers/regions';

const MINUTE = 1200;

/** Analyses a dimension and returns when that was, as the page posts it. */
async function analyse(instance: ServerInstance, key = 'world/region'): Promise<number> {
	expect((await waitForTask(await analysePrunable(instance, key))).state).toBe('done');
	return pruneAnalysis(instance.id)!.at;
}

const prune = async (instance: ServerInstance, settings: PruneSettings, opts: { analysedAt: number; protect?: string[] }) =>
	waitForTask(await pruneChunks(instance, 'world/region', settings, { snapshot: false, analysedAt: opts.analysedAt, protect: new Set(opts.protect ?? []) }));

describe('chunk pruning', () => {
	beforeEach(() => systemdStopped());

	it('picks chunks visited less than the threshold, in both NBT layouts, and keeps what it cannot read', async () => {
		const root = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const base = path.join(root.path, 'world');
		await writeRegion(path.join(base, 'region'), 0, 0, [
			{ index: 0, ticks: 0 },
			{ index: 1, ticks: 50 * MINUTE },
			{ index: 2, ticks: 10, legacy: true },
			{ index: 3, ticks: 0, compression: 4 }, // LZ4: not readable here, so it stays
			{ index: 4, ticks: 0, external: true, pad: 9000 }
		]);
		const plan = await planPrune(base, { maxTicks: MINUTE, keep: null });
		expect(plan).toMatchObject({ chunks: 5, remove: 3, unreadable: 1 });
		expect([...plan.files.get('r.0.0.mca')!].sort()).toEqual([0, 2, 4]);
	});

	it('keeps everything around the spawn', async () => {
		const root = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const base = path.join(root.path, 'world');
		// Region -1,-1: chunk index 1023 is chunk (-1,-1), right next to 0,0; index 0 is (-32,-32).
		await writeRegion(path.join(base, 'region'), -1, -1, [{ index: 1023 }, { index: 0 }]);
		const plan = await planPrune(base, { maxTicks: MINUTE, keep: { x: 0, z: 0, radius: 64 } });
		expect([...plan.files.get('r.-1.-1.mca')!]).toEqual([0]);
	});

	it('rewrites region, entities and poi without the chunks, freeing the space, and deletes emptied files', async () => {
		const root = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const base = path.join(root.path, 'world');
		for (const folder of ['region', 'entities', 'poi']) {
			await writeRegion(path.join(base, folder), 0, 0, [
				{ index: 0, ticks: 0, pad: 20000 },
				{ index: 5, ticks: 9 * MINUTE },
				{ index: 7, ticks: 0, external: true }
			]);
			await writeRegion(path.join(base, folder), 1, 0, [{ index: 0, ticks: 0 }]);
		}
		const sizeBefore = (await fs.stat(path.join(base, 'region', 'r.0.0.mca'))).size;
		const plan = await planPrune(base, { maxTicks: MINUTE, keep: null });
		await applyPrune(base, plan);
		for (const folder of ['region', 'entities', 'poi']) {
			expect(await readRegion(path.join(base, folder, 'r.0.0.mca'))).toEqual({ 5: 9 * MINUTE });
			expect((await fs.readdir(path.join(base, folder))).sort()).toEqual(['r.0.0.mca']);
		}
		expect((await fs.stat(path.join(base, 'region', 'r.0.0.mca'))).size).toBeLessThan(sizeBefore);
	});

	it('reads the spawn kept around from level.dat, 1.21.9 and later too', async () => {
		const compound = (value: [string, Tag][]) => ({ type: 'compound' as const, value });
		const levelDat = (data: [string, Tag][]) => writeNbt({ name: '', gzipped: true, root: compound([['Data', compound(data)]]) });
		const old = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, {
			'world/level.dat': levelDat([['SpawnX', { type: 'int', value: 40 }], ['SpawnY', { type: 'int', value: 64 }], ['SpawnZ', { type: 'int', value: -8 }]])
		});
		expect(await worldSpawn(old.path)).toEqual({ x: 40, z: -8 });
		// 1.21.9 moved it into Data.spawn, where SpawnX/SpawnZ no longer are: the radius kept nothing.
		const recent = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.11' }, {
			'world/level.dat': levelDat([['spawn', compound([['pos', { type: 'intArray', value: [0, 106, -64] }], ['dimension', { type: 'string', value: 'minecraft:overworld' }]])]])
		});
		expect(await worldSpawn(recent.path)).toEqual({ x: 0, z: -64 });
	});

	it('analyses every chunk: its time, its size, and which could not be read', async () => {
		const root = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const base = path.join(root.path, 'world');
		await writeRegion(path.join(base, 'region'), -1, 0, [
			{ index: 0, ticks: 7 },
			{ index: 33, ticks: 3 * MINUTE, legacy: true, pad: 9000, compression: 3 },
			{ index: 2, compression: 4 }
		]);
		const [region] = await analyseRegions(base);
		expect(region).toMatchObject({ x: -1, z: 0 });
		expect([region.ticks[0], region.ticks[33], region.ticks[2], region.ticks[1]]).toEqual([7, 3 * MINUTE, UNREADABLE, NO_CHUNK]);
		expect(region.sectors[33]).toBeGreaterThan(1);
		expect(region.sectors[1]).toBe(0);
	});

	it('analyses, then prunes into a partial snapshot that restores the chunks', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'server.properties': 'level-name=world\n' });
		await writeRegion(path.join(instance.path, 'world', 'region'), 0, 0, [
			{ index: 0, ticks: 0 },
			{ index: 1, ticks: 30 * MINUTE }
		]);
		await writeRegion(path.join(instance.path, 'world', 'DIM-1', 'region'), 0, 0, [{ index: 0, ticks: 0 }]);
		const settings = { maxTicks: MINUTE, keepAroundSpawn: 0 };

		const analysedAt = await analyse(instance);
		expect(pruneAnalysis(instance.id)).toMatchObject({ dimension: 'world/region', chunks: 2, unreadable: 0 });

		const task = await waitForTask(await pruneChunks(instance, 'world/region', settings, { snapshot: true, analysedAt, protect: new Set() }));
		expect(task.state).toBe('done');
		expect(await readRegion(path.join(instance.path, 'world/region/r.0.0.mca'))).toEqual({ 1: 30 * MINUTE });
		// The nether was not touched.
		expect(Object.keys(await readRegion(path.join(instance.path, 'world/DIM-1/region/r.0.0.mca')))).toEqual(['0']);
		// The world changed: the map is drawn again from a new analysis.
		expect(pruneAnalysis(instance.id)).toBeNull();
		const [snapshot] = await listSnapshots(instance.path);
		expect(snapshot).toMatchObject({ reason: 'world-prune', partial: true, label: 'Before pruning overworld' });

		expect((await waitForTask(await restoreSnapshot(instance, snapshot.id, { snapshot: false }))).state).toBe('done');
		expect(await readRegion(path.join(instance.path, 'world/region/r.0.0.mca'))).toEqual({ 0: 0, 1: 30 * MINUTE });
	});

	it('reports the analysis under way, refuses a second one meanwhile, and clears it when done', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		await writeRegion(path.join(instance.path, 'world', 'region'), 0, 0, [{ index: 0 }]);
		const taskId = await analysePrunable(instance, 'world/region');
		expect(runningPruneAnalysis(instance.id)).toEqual({ taskId, dimension: 'world/region' });
		await expect(analysePrunable(instance, 'world/region')).rejects.toThrow(/already running/);
		expect((await waitForTask(taskId)).state).toBe('done');
		expect(runningPruneAnalysis(instance.id)).toBeNull();
		// A failed one is cleared too.
		await fs.rm(path.join(instance.path, 'world', 'region', 'r.0.0.mca'));
		await fs.mkdir(path.join(instance.path, 'world', 'region', 'r.0.0.mca'));
		expect((await waitForTask(await analysePrunable(instance, 'world/region'))).state).toBe('failed');
		expect(runningPruneAnalysis(instance.id)).toBeNull();
	});

	it('keeps the chunks protected on the map', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		// Region 0,-1: index 0 is chunk (0,-32), index 1 is (1,-32).
		await writeRegion(path.join(instance.path, 'world', 'region'), 0, -1, [{ index: 0 }, { index: 1 }, { index: 2 }]);
		const analysedAt = await analyse(instance);
		expect((await prune(instance, { maxTicks: MINUTE, keepAroundSpawn: 0 }, { analysedAt, protect: ['0,-32', '2,-32'] })).state).toBe('done');
		expect(Object.keys(await readRegion(path.join(instance.path, 'world/region/r.0.-1.mca')))).toEqual(['0', '2']);
	});

	it('removes only chunks the analysis showed: ones generated or visited since stay', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const dir = path.join(instance.path, 'world', 'region');
		await writeRegion(dir, 0, 0, [{ index: 0 }, { index: 1 }]);
		const analysedAt = await analyse(instance);
		// The server ran on: chunk 1 got visited, chunk 2 and a whole region are new.
		await writeRegion(dir, 0, 0, [{ index: 0 }, { index: 1, ticks: 20 * MINUTE }, { index: 2 }]);
		await writeRegion(dir, 1, 0, [{ index: 0 }]);
		const task = await prune(instance, { maxTicks: MINUTE, keepAroundSpawn: 0 }, { analysedAt });
		expect(task.state).toBe('done');
		expect(await readRegion(path.join(dir, 'r.0.0.mca'))).toEqual({ 1: 20 * MINUTE, 2: 0 });
		expect(await readRegion(path.join(dir, 'r.1.0.mca'))).toEqual({ 0: 0 });
	});

	it('refuses a prune picked on an older analysis, or when everything it picks is protected', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		await writeRegion(path.join(instance.path, 'world', 'region'), 0, 0, [{ index: 0 }]);
		const analysedAt = await analyse(instance);
		const settings = { maxTicks: MINUTE, keepAroundSpawn: 0 };
		await expect(pruneChunks(instance, 'world/region', settings, { snapshot: false, analysedAt: analysedAt - 1, protect: new Set() })).rejects.toThrow(/Analyse Overworld again/);
		await expect(pruneChunks(instance, 'world/region', settings, { snapshot: false, analysedAt, protect: new Set(['0,0']) })).rejects.toThrow(/every one the threshold picks is protected/);
		expect(Object.keys(await readRegion(path.join(instance.path, 'world/region/r.0.0.mca')))).toEqual(['0']);
	});

	it('leaves the world as it was when MineShell dies at any move', async () => {
		let stops = 0;
		for (let n = 1; ; n++) {
			const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
			await writeRegion(path.join(instance.path, 'world', 'region'), 0, 0, [{ index: 0, ticks: 0 }, { index: 1, ticks: 99 * MINUTE }]);
			const analysedAt = await analyse(instance);
			const before = await tree(instance.path);
			const outcome = await runAndDieAtMove(instance.path, n, () =>
				pruneChunks(instance, 'world/region', { maxTicks: MINUTE, keepAroundSpawn: 0 }, { snapshot: true, analysedAt, protect: new Set() })
			);
			if (outcome === 'finished') break;
			stops++;
			await restartMineShell();
			expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before);
			vi.restoreAllMocks();
			systemdStopped();
		}
		expect(stops).toBeGreaterThanOrEqual(2);
	});
});
