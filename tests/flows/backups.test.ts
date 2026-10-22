import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	addDestination,
	copyBack,
	folderProblem,
	getServerBackup,
	lastBackupResult,
	listDestinations,
	planBackup,
	removeDestination,
	saveServerBackup,
	storeFor,
	syncServer
} from '#lib/server/backups.js';
import { listSnapshots, setSnapshotPinned, setSnapshotDetails, takeSnapshot, type Snapshot } from '#lib/server/snapshots.js';
import { DATA_DIR } from '#lib/server/config.js';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { removeGlobalTarget, saveGlobalTarget } from '#lib/server/notifications.js';
import { createInstance, waitForTask } from '../helpers/instances';
import { useRecordedHttp } from '../helpers/http';

const HOOK = 'https://hooks.example/backups';
const sent: Record<string, unknown>[] = [];
useRecordedHttp('none', {
	extra: {
		[HOOK]: async (init) => {
			sent.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 204 });
		}
	}
});

/**
 * Copies of snapshots in a backup folder (backups.ts): what a sync copies and
 * deletes, the folder checks, failures and copying one back.
 */

/** A folder beside the worker's data folder: backup folders may not be inside it. */
const backupDir = () => fs.mkdtemp(path.join(path.dirname(DATA_DIR), 'backup-'));

let n = 0;
const snap = (ageMin: number, extra: Partial<Snapshot> = {}): Snapshot => ({
	id: `2026-01-01_0000${String(++n).padStart(2, '0')}-scheduled`,
	createdAt: Date.now() - ageMin * 60_000,
	reason: 'scheduled',
	label: '',
	worlds: ['world'],
	sizeBytes: 100,
	minecraftVersion: '1.21.1',
	modloader: 'fabric',
	modloaderVersion: null,
	packVersionName: null,
	...extra
});
const ids = (list: { id: string }[]) => list.map((s) => s.id);

async function server() {
	return createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1' },
		{ 'server.properties': 'level-name=world\n', 'world/level.dat': 'level', 'world/region/r.0.0.mca': 'chunks' }
	);
}

describe('what a sync copies and deletes', () => {
	it('copies what is missing there, newest first, and keeps the newest few', () => {
		const local = [snap(1), snap(2), snap(3)];
		const remote = [snap(10), snap(11)];
		const plan = planBackup(local, remote, { copy: 'all', keep: 4 });
		expect(ids(plan.copy)).toEqual(ids(local));
		expect(plan.remove).toEqual([remote[1].id]);
	});

	it('never copies a snapshot only to delete it, and leaves out partial ones', () => {
		const old = snap(100);
		const partial = snap(1, { partial: true });
		const remote = [snap(10), snap(11)];
		const plan = planBackup([partial, old], remote, { copy: 'all', keep: 2 });
		expect(plan.copy).toEqual([]);
		expect(plan.remove).toEqual([]);
	});

	it('copies only scheduled and hand-taken snapshots when told so', () => {
		const local = [snap(1, { reason: 'pack-change' }), snap(2, { reason: 'manual' }), snap(3)];
		expect(ids(planBackup(local, [], { copy: 'scheduled', keep: 10 }).copy)).toEqual(ids(local.slice(1)));
		expect(ids(planBackup(local, [], { copy: 'all', keep: 10 }).copy)).toEqual(ids(local));
	});

	it('keeps pinned ones outside the count, by the server\'s pin while it has the snapshot', () => {
		const pinnedThere = snap(50, { pinned: true });
		const unpinnedHere = snap(40, { pinned: true });
		const local = [snap(1), { ...unpinnedHere, pinned: false }];
		const plan = planBackup(local, [pinnedThere, unpinnedHere], { copy: 'all', keep: 1 });
		expect(ids(plan.copy)).toEqual([local[0].id]);
		// Unpinned on the server: counted again, and over the one kept.
		expect(plan.remove).toEqual([unpinnedHere.id]);
	});

	it('brings names, tags and pins of copies in line with the server\'s', () => {
		const there = snap(5);
		const here = { ...there, note: 'Before the dragon', tags: ['end'] };
		const plan = planBackup([here], [there], { copy: 'all', keep: 5 });
		expect(plan.manifests).toEqual([expect.objectContaining({ id: there.id, note: 'Before the dragon', tags: ['end'] })]);
	});
});

describe('backup folders', () => {
	beforeEach(() => db.delete(settings).run());

	it('refuses folders that are missing, inside MineShell\'s data or around it', async () => {
		expect(await folderProblem('relative/path')).toMatch(/full path/);
		expect(await folderProblem('/')).toMatch(/whole file system/);
		expect(await folderProblem(path.join(DATA_DIR, 'backups'))).toMatch(/inside MineShell's own data/);
		expect(await folderProblem(path.dirname(DATA_DIR))).toMatch(/data folder is inside/);
		expect(await folderProblem(path.join(path.dirname(DATA_DIR), 'not-mounted'))).toMatch(/no such folder/);
		await expect(addDestination({ name: '', path: path.join(path.dirname(DATA_DIR), 'not-mounted') })).rejects.toThrow(/never makes it/);
		expect(listDestinations()).toEqual([]);
	});

	it('names a folder after itself, and removing it stops the servers copying there', async () => {
		const dir = await backupDir();
		const destination = await addDestination({ name: ' ', path: `${dir}/` });
		expect(destination).toMatchObject({ name: path.basename(dir), path: dir, kind: 'folder' });
		await expect(addDestination({ name: 'again', path: dir })).rejects.toThrow(/already/);
		const s = await server();
		saveServerBackup(s.id, { destination: destination.id, copy: 'all', keep: 3 });
		removeDestination(destination.id);
		expect(getServerBackup(s.id)).toEqual({ destination: null, copy: 'all', keep: 3 });
	});
});

describe('syncing a server', () => {
	beforeEach(() => db.delete(settings).run());

	it('copies finished snapshots, follows pins and deletes past the count there', async () => {
		const dir = await backupDir();
		const destination = await addDestination({ name: 'USB', path: dir });
		const s = await server();
		const first = (await takeSnapshot(s, { reason: 'manual', label: 'one' }))!;
		saveServerBackup(s.id, { destination: destination.id, copy: 'all', keep: 1 });

		await syncServer(s.id);
		expect(await fs.readFile(path.join(dir, s.id, first.id, 'world/region/r.0.0.mca'), 'utf8')).toBe('chunks');
		expect(lastBackupResult(s.id)).toMatchObject({ ok: true, message: 'Copied 1 snapshot.' });

		await setSnapshotPinned(s.path, first.id, true);
		await new Promise((r) => setTimeout(r, 1100));
		const second = (await takeSnapshot(s, { reason: 'manual', label: 'two' }))!;
		await syncServer(s.id);
		expect(ids(await storeFor(destination).list(s.id))).toEqual([second.id, first.id]);
		expect((await storeFor(destination).list(s.id))[1].pinned).toBe(true);

		await setSnapshotPinned(s.path, first.id, false);
		await setSnapshotDetails(s.path, second.id, { note: 'Kept', tags: [] });
		await syncServer(s.id);
		const there = await storeFor(destination).list(s.id);
		expect(ids(there)).toEqual([second.id]);
		expect(there[0].note).toBe('Kept');
		// Nothing half-written left behind.
		expect(await fs.readdir(path.join(dir, s.id))).toEqual([second.id]);
	});

	it('fails without creating a folder that is not there, and copies once it is back', async () => {
		const dir = await backupDir();
		const destination = await addDestination({ name: 'NAS', path: dir });
		const s = await server();
		await takeSnapshot(s, { reason: 'scheduled', label: 'one' });
		saveServerBackup(s.id, { destination: destination.id, copy: 'all', keep: 5 });

		// Unmounted: the mount point is gone or empty, and nothing may be written under it.
		await fs.rm(dir, { recursive: true });
		await syncServer(s.id);
		expect(lastBackupResult(s.id)).toMatchObject({ ok: false, message: expect.stringMatching(/is the drive mounted/) });
		await expect(fs.stat(dir)).rejects.toThrow();

		await fs.mkdir(dir);
		await syncServer(s.id);
		expect(lastBackupResult(s.id)).toMatchObject({ ok: true });
		expect(await storeFor(destination).list(s.id)).toHaveLength(1);
	});

	it('notifies once when copies start failing, and again only after one worked', async () => {
		const dir = await backupDir();
		const destination = await addDestination({ name: 'NAS', path: dir });
		const s = await server();
		await takeSnapshot(s, { reason: 'scheduled', label: 'one' });
		saveServerBackup(s.id, { destination: destination.id, copy: 'all', keep: 5 });
		saveGlobalTarget({ type: 'webhook', url: HOOK, kinds: ['backup'] });
		sent.length = 0;
		const settle = () => new Promise((r) => setTimeout(r, 20));
		try {
			await fs.rm(dir, { recursive: true });
			await syncServer(s.id);
			await syncServer(s.id);
			await settle();
			expect(sent).toEqual([expect.objectContaining({ event: 'backup', title: 'Backup copy failed' })]);
			await fs.mkdir(dir);
			await syncServer(s.id);
			await fs.rm(dir, { recursive: true });
			await syncServer(s.id);
			await settle();
			expect(sent).toHaveLength(2);
		} finally {
			removeGlobalTarget();
		}
	});

	it('copies a snapshot back, also one of a server that is gone', async () => {
		const dir = await backupDir();
		const destination = await addDestination({ name: 'Disk', path: dir });
		const gone = await server();
		const old = (await takeSnapshot(gone, { reason: 'manual', label: 'one' }))!;
		saveServerBackup(gone.id, { destination: destination.id, copy: 'all', keep: 5 });
		await syncServer(gone.id);

		const again = await server();
		saveServerBackup(again.id, { destination: destination.id, copy: 'all', keep: 5 });
		await expect(copyBack(again, old.id)).rejects.toThrow(/no longer there/);
		await waitForTask(await copyBack(again, old.id, gone.id));
		const [back] = await listSnapshots(again.path);
		expect(back).toMatchObject({ id: old.id, label: 'one' });
		expect(await fs.readFile(path.join(again.path, '.mineshell/snapshots', old.id, 'world/level.dat'), 'utf8')).toBe('level');
		await expect(copyBack(again, old.id, gone.id)).rejects.toThrow(/has that snapshot already/);
		await expect(copyBack(again, old.id, '../etc')).rejects.toThrow(/No such copy/);
	});
});
