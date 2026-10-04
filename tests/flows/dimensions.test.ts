import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listDimensions } from '#lib/server/dimensions.js';
import { listSnapshots, SNAPSHOTS_DIR } from '#lib/server/snapshots.js';
import { resetDimension, restoreDimension, restoreSnapshot, snapshotNow } from '#lib/server/world.js';
import { createInstance, reload, systemdStopped, tree, waitForTask } from '../helpers/instances';
import { restartMineShell, runAndDieAtMove } from '../helpers/crash';

/** A 1.21 world with a nether, an end, a datapack dimension and a mod's dimension the 1.12 way. */
const FILES = {
	'server.properties': 'level-name=world\n',
	'world/level.dat': 'level',
	'world/playerdata/alex.dat': 'alex',
	'world/data/raids.dat': 'raids',
	'world/region/r.0.0.mca': 'overworld',
	'world/entities/r.0.0.mca': 'overworld mobs',
	'world/poi/r.0.0.mca': 'overworld poi',
	'world/DIM-1/region/r.0.0.mca': 'nether',
	'world/DIM1/region/r.0.0.mca': 'end',
	'world/AoA_Abyss/region/r.0.0.mca': 'abyss',
	'world/dimensions/tensura/labyrinth/region/r.0.0.mca': 'labyrinth',
	'world/dimensions/tensura/notes.txt': 'not a dimension'
};

const server = () => createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, FILES);
const read = (root: string, rel: string) => fs.readFile(path.join(root, rel), 'utf8').catch(() => null);

describe('one dimension at a time', () => {
	beforeEach(() => systemdStopped());

	it('finds every kind of dimension folder', async () => {
		const instance = await server();
		await fs.mkdir(path.join(instance.path, 'world_the_end', 'DIM1', 'region'), { recursive: true });
		const dims = await listDimensions(instance.path);
		expect(dims.map((d) => [d.id, d.label, d.paths])).toEqual([
			['minecraft:overworld', 'Overworld', ['world/region', 'world/entities', 'world/poi']],
			['AoA_Abyss', 'AoA_Abyss', ['world/AoA_Abyss']],
			['minecraft:the_nether', 'The Nether', ['world/DIM-1']],
			['minecraft:the_end', 'The End', ['world/DIM1']],
			['tensura:labyrinth', 'tensura:labyrinth', ['world/dimensions/tensura/labyrinth']],
			['minecraft:the_end', 'The End', ['world_the_end']]
		]);
	});

	it('resets the nether into a partial snapshot and leaves the rest alone', async () => {
		const instance = await server();
		const before = await tree(instance.path);
		expect((await waitForTask(await resetDimension(instance, 'world/DIM-1', { snapshot: true }))).state).toBe('done');

		const after = await tree(instance.path);
		const { 'world/DIM-1/region/r.0.0.mca': gone, ...rest } = before;
		expect(gone).toBe('nether');
		expect(after).toEqual(rest);
		const [snapshot] = await listSnapshots(instance.path);
		expect(snapshot).toMatchObject({ reason: 'world-reset-dimension', worlds: ['world/DIM-1'], partial: true, label: 'Before resetting the nether' });
		expect(reload(instance.id)).toMatchObject({ status: 'ready' });

		// Restoring that snapshot puts back the nether only; later overworld changes stay.
		await fs.writeFile(path.join(instance.path, 'world/region/r.0.0.mca'), 'overworld, later');
		expect((await waitForTask(await restoreSnapshot(instance, snapshot.id, { snapshot: false }))).state).toBe('done');
		expect(await read(instance.path, 'world/DIM-1/region/r.0.0.mca')).toBe('nether');
		expect(await read(instance.path, 'world/region/r.0.0.mca')).toBe('overworld, later');
		expect(await read(instance.path, 'world/level.dat')).toBe('level');
	});

	it("resets the overworld's terrain only: level.dat, player data and world data stay", async () => {
		const instance = await server();
		expect((await waitForTask(await resetDimension(instance, 'world/region', { snapshot: false }))).state).toBe('done');
		for (const gone of ['world/region', 'world/entities', 'world/poi']) {
			expect(await fs.access(path.join(instance.path, gone)).then(() => true, () => false)).toBe(false);
		}
		expect(await read(instance.path, 'world/level.dat')).toBe('level');
		expect(await read(instance.path, 'world/playerdata/alex.dat')).toBe('alex');
		expect(await read(instance.path, 'world/data/raids.dat')).toBe('raids');
		expect(await read(instance.path, 'world/DIM-1/region/r.0.0.mca')).toBe('nether');
		expect(await fs.readdir(path.join(instance.path, '.mineshell')).catch(() => [])).toEqual([]);
	});

	it('restores one dimension from a whole-world snapshot', async () => {
		const instance = await server();
		expect((await waitForTask(await snapshotNow(instance))).state).toBe('done');
		const [full] = await listSnapshots(instance.path);
		await fs.writeFile(path.join(instance.path, 'world/dimensions/tensura/labyrinth/region/r.0.0.mca'), 'griefed');
		await fs.writeFile(path.join(instance.path, 'world/region/r.0.0.mca'), 'overworld, later');

		const taskId = await restoreDimension(instance, full.id, 'world/dimensions/tensura/labyrinth', { snapshot: true });
		expect((await waitForTask(taskId)).state).toBe('done');
		expect(await read(instance.path, 'world/dimensions/tensura/labyrinth/region/r.0.0.mca')).toBe('labyrinth');
		expect(await read(instance.path, 'world/region/r.0.0.mca')).toBe('overworld, later');
		// The griefed labyrinth is kept, as a partial snapshot of its own.
		const newest = (await listSnapshots(instance.path))[0];
		expect(newest).toMatchObject({ partial: true, worlds: ['world/dimensions/tensura/labyrinth'] });
		await expect(restoreDimension(instance, full.id, 'world/DIM99', { snapshot: false })).rejects.toThrow(/does not have/);
	});

	it('puts everything back when MineShell dies at any move', async () => {
		let stops = 0;
		for (let n = 1; ; n++) {
			const instance = await server();
			const before = await tree(instance.path);
			const outcome = await runAndDieAtMove(instance.path, n, () => resetDimension(instance, 'world/region', { snapshot: true }));
			if (outcome === 'finished') break;
			stops++;
			await restartMineShell();
			expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before);
			expect(await fs.readdir(path.join(instance.path, SNAPSHOTS_DIR)).catch(() => [])).toEqual([]);
			vi.restoreAllMocks();
			systemdStopped();
		}
		expect(stops).toBeGreaterThanOrEqual(3);
	});
});
