import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteOldLogs, diskBreakdown } from '#lib/server/diskusage.js';
import { setSnapshotPinned, takeSnapshot } from '#lib/server/snapshots.js';
import { createInstance } from '../helpers/instances';

const bytes = (n: number) => 'x'.repeat(n);

/** A modded server with every kind of folder the breakdown knows. Sizes are distinct so each shows where it went. */
async function server() {
	const files: Record<string, string> = {
		'server.properties': 'level-name=world\n',
		'world/region/r.0.0.mca': bytes(1000),
		'world/playerdata/a.dat': bytes(30),
		'world/DIM-1/region/r.0.0.mca': bytes(200),
		'world/DIM1/region/r.0.0.mca': bytes(150),
		'world/DIM144/region/r.0.0.mca': bytes(120),
		'world/AoA_Abyss/region/r.0.0.mca': bytes(110),
		'world/dimensions/tensura/labyrinth/region/r.0.0.mca': bytes(90),
		'world/dimensions/tensura/notes.txt': bytes(7),
		'world_nether/region/r.0.0.mca': bytes(80),
		'old-configs/2026-09-01-v1.2/config/a.cfg': bytes(60),
		'old-configs/2026-10-01-v1.3/config/a.cfg': bytes(50),
		'logs/latest.log': bytes(40),
		'logs/2026-01-01-1.log.gz': bytes(25),
		'logs/2026-10-03-1.log.gz': bytes(15),
		'crash-reports/crash-2026-01-02_10.00.00-server.txt': bytes(12),
		'mods/a.jar': bytes(500),
		'libraries/net/x.jar': bytes(400),
		'server.jar': bytes(300),
		'config/a.cfg': bytes(20),
		'.mineshell/forge-backup/forge.jar': bytes(70),
		'.mineshell/pack-change-1791000000000/mods/old.jar': bytes(65)
	};
	const instance = await createInstance({ modloader: 'forge', minecraftVersion: '1.12.2' }, files);
	// Two months old: archived logs and crash reports past the cutoff.
	const old = new Date(Date.now() - 60 * 86_400_000);
	for (const rel of ['logs/2026-01-01-1.log.gz', 'crash-reports/crash-2026-01-02_10.00.00-server.txt']) {
		await fs.utimes(path.join(instance.path, rel), old, old);
	}
	return instance;
}

async function onDisk(dir: string): Promise<number> {
	let total = 0;
	for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
	}
	return total;
}

describe('disk usage breakdown', () => {
	it('counts every file once, in groups that add up to the total', async () => {
		const instance = await server();
		const usage = await diskBreakdown(instance);
		expect(usage.total).toBe(await onDisk(instance.path));
		expect(usage.groups.reduce((sum, g) => sum + g.bytes, 0)).toBe(usage.total);
		const group = (id: string) => usage.groups.find((g) => g.id === id)!;
		expect(group('mods').bytes).toBe(500);
		expect(group('loader').items.map((i) => i.label).sort()).toEqual(['libraries', 'server.jar']);
		expect(group('logs').bytes).toBe(40 + 25 + 15 + 12);
		expect(group('old-configs').items.map((i) => [i.label, i.bytes])).toEqual([
			['2026-09-01-v1.2', 60],
			['2026-10-01-v1.3', 50]
		]);
		expect(group('other').items.map((i) => i.label).sort()).toEqual(['config', 'server.properties']);
	});

	it('splits the world by dimension: vanilla, 1.12 modded, named and namespaced, Bukkit siblings', async () => {
		const usage = await diskBreakdown(await server());
		const world = usage.groups.find((g) => g.id === 'world')!;
		expect(world.items.map((i) => [i.label, i.path, i.bytes])).toEqual([
			['Overworld and world data', 'world', 1000 + 30 + 7],
			['The Nether', path.join('world', 'DIM-1'), 200],
			['The End', path.join('world', 'DIM1'), 150],
			['DIM144', path.join('world', 'DIM144'), 120],
			['AoA_Abyss', path.join('world', 'AoA_Abyss'), 110],
			['tensura:labyrinth', path.join('world', 'dimensions', 'tensura', 'labyrinth'), 90],
			// The Bukkit-style sibling folder.
			['The Nether', 'world_nether', 80]
		]);
	});

	it('lists snapshots and MineShell backups, and suggests what could go', async () => {
		const instance = await server();
		const kept = await takeSnapshot(instance, { reason: 'manual', label: 'Before the boss fight' });
		await takeSnapshot(instance, { reason: 'manual', label: 'Old one' });
		await setSnapshotPinned(instance.path, kept!.id, true);

		const usage = await diskBreakdown(instance);
		const mineshell = usage.groups.find((g) => g.id === 'mineshell')!;
		expect(mineshell.items.map((i) => [i.label, i.note])).toEqual(
			expect.arrayContaining([
				['Snapshot: Before the boss fight', 'pinned'],
				['Snapshot: Old one', undefined],
				['Forge kept for undoing the Cleanroom migration', undefined],
				['Left over from an interrupted operation (pack-change-1791000000000)', undefined]
			])
		);
		const texts = usage.suggestions.map((s) => s.text);
		expect(texts.some((t) => t.startsWith('1 unpinned world snapshot.'))).toBe(true);
		expect(texts.some((t) => t.startsWith('Configs that pack changes moved aside (2 versions)'))).toBe(true);
		expect(texts.some((t) => t.includes('pack-change-1791000000000 was left by an operation'))).toBe(true);
		expect(usage.suggestions.find((s) => s.action === 'deleteOldLogs')).toMatchObject({ bytes: 25 + 12 });
	});

	it('deletes only archived logs and crash reports past the cutoff', async () => {
		const instance = await server();
		expect(await deleteOldLogs(instance.path)).toEqual({ files: 2, bytes: 37 });
		expect((await fs.readdir(path.join(instance.path, 'logs'))).sort()).toEqual(['2026-10-03-1.log.gz', 'latest.log']);
		expect(await fs.readdir(path.join(instance.path, 'crash-reports'))).toEqual([]);
		expect((await diskBreakdown(instance)).suggestions.some((s) => s.action)).toBe(false);
	});
});
