import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	deleteSnapshot,
	DEFAULT_POLICY,
	diskBytes,
	hashFile,
	listSnapshots,
	pruneSnapshots,
	readHashes,
	snapshotFiles,
	snapshotPath,
	snapshotUsage,
	takeSnapshot,
	type Snapshot
} from '#lib/server/snapshots.js';
import { restoreSnapshot, worldFromSnapshot } from '#lib/server/world.js';
import { CACHE_DIR } from '#lib/server/config.js';
import { createInstance, reload, systemdStopped, waitForTask } from '../helpers/instances';

/**
 * Snapshots share the files that did not change as hard links (snapshots.ts
 * copyWorld): what is shared, that deleting one never touches the others,
 * and that the live world never shares a file with a snapshot.
 */

const BIG = 'x'.repeat(64 * 1024);

async function server() {
	return createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1' },
		{
			'server.properties': 'level-name=world\n',
			'world/level.dat': 'level',
			'world/region/r.0.0.mca': BIG,
			'world/region/r.0.1.mca': 'changes'
		}
	);
}

const inode = async (file: string) => (await fs.stat(file)).ino;
const take = async (instance: Awaited<ReturnType<typeof server>>, label: string) => {
	// A later millisecond, so the order by time is certain (ids in the same second get a -2).
	await new Promise((r) => setTimeout(r, 2));
	return (await takeSnapshot(instance, { reason: 'manual', label }))!;
};

/** Every file of a snapshot still has the contents its hashes say. */
async function intact(root: string, snapshot: Snapshot): Promise<void> {
	const dir = snapshotPath(root, snapshot.id);
	const records = (await readHashes(dir))!;
	expect(Object.keys(records).length).toBeGreaterThan(0);
	for (const [rel, [size, , hash]] of Object.entries(records)) {
		expect((await fs.stat(path.join(dir, rel))).size).toBe(size);
		expect(await hashFile(path.join(dir, rel))).toBe(hash);
	}
}

/** No file of the live world has a second name. */
async function liveUnshared(root: string, dir = 'world'): Promise<void> {
	for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		expect((await fs.stat(path.join(entry.parentPath, entry.name))).nlink, path.join(entry.parentPath, entry.name)).toBe(1);
	}
}

beforeEach(() => systemdStopped());
afterEach(() => vi.restoreAllMocks());

describe('snapshots sharing unchanged files', () => {
	it('links what did not change to the snapshot before and copies what did', async () => {
		const s = await server();
		const first = await take(s, 'one');
		await fs.writeFile(path.join(s.path, 'world/region/r.0.1.mca'), 'changed!');
		const second = await take(s, 'two');
		const at = (snap: Snapshot, rel: string) => path.join(snapshotPath(s.path, snap.id), rel);
		expect(await inode(at(second, 'world/region/r.0.0.mca'))).toBe(await inode(at(first, 'world/region/r.0.0.mca')));
		expect(await inode(at(second, 'world/region/r.0.1.mca'))).not.toBe(await inode(at(first, 'world/region/r.0.1.mca')));
		expect(await fs.readFile(at(second, 'world/region/r.0.1.mca'), 'utf8')).toBe('changed!');
		await intact(s.path, first);
		await intact(s.path, second);
		await liveUnshared(s.path);
		// On disk the shared file counts once.
		const files = await snapshotFiles(s.path, await listSnapshots(s.path));
		const once = diskBytes(files);
		// The region file and level.dat did not change.
		expect(once.shared).toBe(BIG.length + 'level'.length);
		expect((await snapshotUsage(s.path)).bytes).toBe(once.total);
		expect(once.total).toBeLessThan(first.sizeBytes + second.sizeBytes);
	});

	it.each([
		['by its Delete', (root: string, id: string) => deleteSnapshot(root, id)],
		['by hand', (root: string, id: string) => fs.rm(snapshotPath(root, id), { recursive: true, force: true })],
		['by retention', (root: string) => pruneSnapshots(root, { ...DEFAULT_POLICY, keepMin: 1, keepMax: 1 })]
	])('leaves the other snapshots whole when one is deleted %s', async (_, remove) => {
		const s = await server();
		const first = await take(s, 'one');
		const second = await take(s, 'two');
		const third = await take(s, 'three');
		await remove(s.path, second.id);
		if (_ === 'by retention') {
			expect((await listSnapshots(s.path)).map((x) => x.id)).toEqual([third.id]);
			await intact(s.path, third);
		} else {
			expect((await listSnapshots(s.path)).map((x) => x.id)).toEqual([third.id, first.id]);
			await intact(s.path, first);
			await intact(s.path, third);
		}
		// What is left still links: a fourth shares with the third.
		const fourth = await take(s, 'four');
		expect(await inode(path.join(snapshotPath(s.path, fourth.id), 'world/region/r.0.0.mca'))).toBe(
			await inode(path.join(snapshotPath(s.path, third.id), 'world/region/r.0.0.mca'))
		);
	});

	it('never links to a file changed in place since it was recorded, nor to snapshots without records', async () => {
		const s = await server();
		const first = await take(s, 'one');
		// A snapshot from before shared files: no records, nothing links to it.
		await fs.rm(path.join(snapshotPath(s.path, first.id), 'hashes.json'));
		const second = await take(s, 'two');
		const at = (snap: Snapshot) => path.join(snapshotPath(s.path, snap.id), 'world/region/r.0.0.mca');
		expect(await inode(at(second))).not.toBe(await inode(at(first)));
		// Changed in place behind MineShell's back, same size: its record no longer fits.
		await fs.writeFile(at(second), 'y'.repeat(BIG.length));
		const third = await take(s, 'three');
		expect(await inode(at(third))).not.toBe(await inode(at(second)));
		expect(await fs.readFile(at(third), 'utf8')).toBe(BIG);
	});

	it('keeps the live world apart after restoring and after making a world of a snapshot', async () => {
		const s = await server();
		const first = await take(s, 'one');
		await take(s, 'two');
		await waitForTask(await restoreSnapshot(reload(s.id), first.id, { snapshot: true }));
		await liveUnshared(s.path);
		const third = await take(s, 'three');
		// The restored world is the first snapshot's files: the next snapshot links to them, the live world does not.
		expect(await inode(path.join(snapshotPath(s.path, third.id), 'world/region/r.0.0.mca'))).not.toBe(
			await inode(path.join(s.path, 'world/region/r.0.0.mca'))
		);
		await liveUnshared(s.path);
		const { taskId, folder } = await worldFromSnapshot(reload(s.id), first.id, 'Old times');
		await waitForTask(taskId);
		await liveUnshared(s.path, folder);
	});

	it('copies instead when the file system refuses a link', async () => {
		const s = await server();
		const first = await take(s, 'one');
		// No hard links there (some network shares), or the file has too many names already.
		vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('EMLINK: too many links'), { code: 'EMLINK' }));
		const second = await take(s, 'two');
		const at = (snap: Snapshot) => path.join(snapshotPath(s.path, snap.id), 'world/region/r.0.0.mca');
		expect(fs.link).toHaveBeenCalled();
		expect(await inode(at(second))).not.toBe(await inode(at(first)));
		await intact(s.path, second);
	});

	it('keeps the file lists in the cache folder across restarts, and drops those of deleted snapshots', async () => {
		const s = await server();
		const first = await take(s, 'one');
		const second = await take(s, 'two');
		const before = await snapshotFiles(s.path, await listSnapshots(s.path));
		const cache = path.join(CACHE_DIR, 'snapshot-files', path.basename(s.path));
		expect((await fs.readdir(cache)).length).toBe(2);
		// As after a restart: memory empty, the cache folder answers.
		(globalThis as { __mineshellSnapshotFiles?: Map<string, unknown> }).__mineshellSnapshotFiles!.clear();
		expect(await snapshotFiles(s.path, await listSnapshots(s.path))).toEqual(before);
		await deleteSnapshot(s.path, first.id);
		await snapshotFiles(s.path, await listSnapshots(s.path));
		expect((await fs.readdir(cache)).map((n) => n.split('@')[0])).toEqual([second.id]);
	});

	it('counts a shared file once against the storage budget', async () => {
		const s = await server();
		await take(s, 'one');
		await take(s, 'two');
		await take(s, 'three');
		const snapshots = await listSnapshots(s.path);
		// Three snapshots of ~64 KB each, sharing it: 0.1 MB holds all of them, not 0.2.
		const policy = { ...DEFAULT_POLICY, keepMin: 1, budgetMb: 0.1 };
		const { snapshotsToDelete } = await import('#lib/server/snapshots.js');
		expect(snapshotsToDelete(snapshots, policy, await snapshotFiles(s.path, snapshots))).toEqual([]);
		expect(snapshotsToDelete(snapshots, policy).length).toBeGreaterThan(0);
	});
});
