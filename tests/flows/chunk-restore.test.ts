import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listSnapshots } from '#lib/server/snapshots.js';
import { restoreChunks, restoreSnapshot, snapshotNow } from '#lib/server/world.js';
import { createInstance, systemdStopped, tree, waitForTask } from '../helpers/instances';
import { restartMineShell, runAndDieAtMove } from '../helpers/crash';
import { readRegion, writeRegion } from '../helpers/regions';

/** A server whose snapshot has every chunk at InhabitedTime 1 (2 for the nether); the live world then changes to 9. */
async function serverWithSnapshot() {
	const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'server.properties': 'level-name=world\n' });
	const world = path.join(instance.path, 'world');
	for (const folder of ['region', 'entities', 'poi']) {
		await writeRegion(path.join(world, folder), 0, 0, [{ index: 0, ticks: 1 }, { index: 1, ticks: 1 }, { index: 2, ticks: 1, external: true, pad: 9000 }]);
	}
	await writeRegion(path.join(world, 'DIM-1', 'region'), 0, 0, [{ index: 0, ticks: 2 }]);
	expect((await waitForTask(await snapshotNow(instance))).state).toBe('done');
	const [snapshot] = await listSnapshots(instance.path);
	// After the snapshot: everything changed, a new chunk (3) was generated, chunk 2 is small now,
	// and a region the snapshot does not have appeared.
	for (const folder of ['region', 'entities', 'poi']) {
		await fs.rm(path.join(world, folder), { recursive: true });
		await writeRegion(path.join(world, folder), 0, 0, [{ index: 0, ticks: 9 }, { index: 1, ticks: 9 }, { index: 2, ticks: 9 }, { index: 3, ticks: 9 }]);
	}
	await writeRegion(path.join(world, 'region'), -1, 0, [{ index: 31, ticks: 9 }]);
	await writeRegion(path.join(world, 'DIM-1', 'region'), 0, 0, [{ index: 0, ticks: 9 }]);
	return { instance, world, snapshot };
}

describe('restoring chunks from a snapshot', () => {
	beforeEach(() => systemdStopped());

	it('puts back only the chosen chunks, in region, entities and poi, and removes chosen ones the snapshot never had', async () => {
		const { instance, world, snapshot } = await serverWithSnapshot();
		// Chunks (0,0) and (2,0) from the snapshot; (3,0) did not exist then; (-1,0) is in a region the snapshot lacks.
		const task = await restoreChunks(instance, snapshot.id, 'world/region', [[0, 0], [2, 0], [3, 0], [-1, 0]], { snapshot: true });
		expect((await waitForTask(task)).state).toBe('done');

		for (const folder of ['region', 'entities', 'poi']) {
			expect(await readRegion(path.join(world, folder, 'r.0.0.mca'))).toEqual({ 0: 1, 1: 9, 2: 1 });
			// Chunk 2 came back as the snapshot had it: in its own file.
			expect(await fs.readdir(path.join(world, folder))).toContain('c.2.0.mcc');
		}
		// The region the snapshot did not have lost its only chosen chunk, and with it the file.
		expect(await fs.readdir(path.join(world, 'region'))).not.toContain('r.-1.0.mca');
		// The nether was not touched.
		expect(await readRegion(path.join(world, 'DIM-1', 'region', 'r.0.0.mca'))).toEqual({ 0: 9 });

		// What was there is kept as a snapshot of just the changed files, which puts them back.
		const before = (await listSnapshots(instance.path)).find((s) => s.reason === 'world-restore-chunks')!;
		expect(before).toMatchObject({ partial: true, label: 'Before restoring 4 chunks of overworld' });
		expect(before.worlds.sort()).toEqual(['world/entities/r.0.0.mca', 'world/poi/r.0.0.mca', 'world/region/r.-1.0.mca', 'world/region/r.0.0.mca']);
		expect((await waitForTask(await restoreSnapshot(instance, before.id, { snapshot: false }))).state).toBe('done');
		for (const folder of ['region', 'entities', 'poi']) {
			expect(await readRegion(path.join(world, folder, 'r.0.0.mca'))).toEqual({ 0: 9, 1: 9, 2: 9, 3: 9 });
		}
		expect(await readRegion(path.join(world, 'region', 'r.-1.0.mca'))).toEqual({ 31: 9 });
		// And what the restore created, the snapshot's chunk 2 in its own file, is gone again.
		expect(before.created?.sort()).toEqual(['world/entities/c.2.0.mcc', 'world/poi/c.2.0.mcc', 'world/region/c.2.0.mcc']);
		for (const folder of ['region', 'entities', 'poi']) expect(await fs.readdir(path.join(world, folder))).not.toContain('c.2.0.mcc');
	});

	it('undoes a restore of chunks the world never had, which only created files', async () => {
		const { instance, world, snapshot } = await serverWithSnapshot();
		// The world loses a region the snapshot still has; restoring a chunk of it creates the file.
		await fs.rm(path.join(world, 'DIM-1', 'region', 'r.0.0.mca'));
		expect((await waitForTask(await restoreChunks(instance, snapshot.id, 'world/DIM-1', [[0, 0]], { snapshot: true }))).state).toBe('done');
		expect(await readRegion(path.join(world, 'DIM-1', 'region', 'r.0.0.mca'))).toEqual({ 0: 2 });

		const before = (await listSnapshots(instance.path)).find((s) => s.reason === 'world-restore-chunks')!;
		expect(before).toMatchObject({ partial: true, worlds: [], created: ['world/DIM-1/region/r.0.0.mca'] });
		expect((await waitForTask(await restoreSnapshot(instance, before.id, { snapshot: false }))).state).toBe('done');
		expect(await fs.readdir(path.join(world, 'DIM-1', 'region'))).toEqual([]);
	});

	it('moves a chosen chunk kept in its own file aside, and leaves the others', async () => {
		const { instance, world, snapshot } = await serverWithSnapshot();
		// Now the live chunk 2 is the big one, chunk 1 too; only chunk 2 is chosen.
		for (const folder of ['region', 'entities', 'poi']) {
			await fs.rm(path.join(world, folder), { recursive: true });
			await writeRegion(path.join(world, folder), 0, 0, [
				{ index: 1, ticks: 9, external: true, pad: 9000 },
				{ index: 2, ticks: 9, external: true, pad: 9000 }
			]);
		}
		expect((await waitForTask(await restoreChunks(instance, snapshot.id, 'world/region', [[2, 0]], { snapshot: false }))).state).toBe('done');
		const files = (await fs.readdir(path.join(world, 'region'))).sort();
		expect(files).toEqual(['c.1.0.mcc', 'c.2.0.mcc', 'r.0.0.mca']);
		expect(await readRegion(path.join(world, 'region', 'r.0.0.mca'))).toEqual({ 1: 9, 2: 1 });
	});

	it('refuses chunks neither side has, and snapshots of another dimension', async () => {
		const { instance, snapshot } = await serverWithSnapshot();
		await expect(restoreChunks(instance, snapshot.id, 'world/region', [[100, 100]], { snapshot: false })).rejects.toThrow(/any of those chunks/);
		await expect(restoreChunks(instance, snapshot.id, 'world/DIM1', [[0, 0]], { snapshot: false })).rejects.toThrow(/does not have this dimension/);
		await expect(restoreChunks(instance, snapshot.id, 'world/region', [], { snapshot: false })).rejects.toThrow(/Pick the chunks/);
	});

	it('leaves the world as it was when MineShell dies at any move', async () => {
		let stops = 0;
		for (let n = 1; ; n++) {
			const { instance, snapshot } = await serverWithSnapshot();
			const before = await tree(instance.path);
			const outcome = await runAndDieAtMove(instance.path, n, () =>
				restoreChunks(instance, snapshot.id, 'world/region', [[0, 0], [2, 0], [-1, 0]], { snapshot: true })
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
