import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPrune, planPrune } from '#lib/server/chunkprune.js';
import { listSnapshots } from '#lib/server/snapshots.js';
import { countPrunable, lastPruneCount, pruneChunks, restoreSnapshot } from '#lib/server/world.js';
import { createInstance, systemdStopped, tree, waitForTask } from '../helpers/instances';
import { restartMineShell, runAndDieAtMove } from '../helpers/crash';
import { readRegion, writeRegion } from '../helpers/regions';

const MINUTE = 1200;

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

	it('counts, then prunes into a partial snapshot that restores the chunks', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'server.properties': 'level-name=world\n' });
		await writeRegion(path.join(instance.path, 'world', 'region'), 0, 0, [
			{ index: 0, ticks: 0 },
			{ index: 1, ticks: 30 * MINUTE }
		]);
		await writeRegion(path.join(instance.path, 'world', 'DIM-1', 'region'), 0, 0, [{ index: 0, ticks: 0 }]);
		const settings = { maxTicks: MINUTE, keepAroundSpawn: 0 };

		expect((await waitForTask(await countPrunable(instance, 'world/region', settings))).state).toBe('done');
		expect(lastPruneCount(instance.id)).toMatchObject({ dimension: 'world/region', chunks: 2, remove: 1 });

		expect((await waitForTask(await pruneChunks(instance, 'world/region', settings, { snapshot: true }))).state).toBe('done');
		expect(await readRegion(path.join(instance.path, 'world/region/r.0.0.mca'))).toEqual({ 1: 30 * MINUTE });
		// The nether was not touched.
		expect(Object.keys(await readRegion(path.join(instance.path, 'world/DIM-1/region/r.0.0.mca')))).toEqual(['0']);
		const [snapshot] = await listSnapshots(instance.path);
		expect(snapshot).toMatchObject({ reason: 'world-prune', partial: true, label: 'Before pruning overworld' });

		expect((await waitForTask(await restoreSnapshot(instance, snapshot.id, { snapshot: false }))).state).toBe('done');
		expect(await readRegion(path.join(instance.path, 'world/region/r.0.0.mca'))).toEqual({ 0: 0, 1: 30 * MINUTE });
	});

	it('leaves the world as it was when MineShell dies at any move', async () => {
		let stops = 0;
		for (let n = 1; ; n++) {
			const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
			await writeRegion(path.join(instance.path, 'world', 'region'), 0, 0, [{ index: 0, ticks: 0 }, { index: 1, ticks: 99 * MINUTE }]);
			const before = await tree(instance.path);
			const outcome = await runAndDieAtMove(instance.path, n, () =>
				pruneChunks(instance, 'world/region', { maxTicks: MINUTE, keepAroundSpawn: 0 }, { snapshot: true })
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
