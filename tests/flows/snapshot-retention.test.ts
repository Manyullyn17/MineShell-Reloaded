import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import {
	decideSnapshot,
	DEFAULT_POLICY,
	getSnapshotPolicy,
	LowDiskSpaceError,
	policyFromForm,
	saveServerSnapshotOverrides,
	saveSnapshotPolicy,
	SnapshotChoiceNeeded,
	snapshotsToDelete,
	takeSnapshot,
	type Snapshot
} from '#lib/server/snapshots.js';
import { snapshotNow } from '#lib/server/world.js';
import { createInstance, systemdStopped } from '../helpers/instances';

const MB = 1024 * 1024;
const GB = 1024 * MB;

let n = 0;
/** A snapshot `ageMin` minutes old. */
const snap = (ageMin: number, size: number, extra: Partial<Snapshot> = {}): Snapshot => ({
	id: `s${++n}-${ageMin}`,
	createdAt: Date.now() - ageMin * 60_000,
	reason: 'manual',
	label: '',
	worlds: ['world'],
	sizeBytes: size,
	minecraftVersion: '1.21.1',
	modloader: 'fabric',
	modloaderVersion: null,
	packVersionName: null,
	...extra
});

const ids = (list: Snapshot[]) => list.map((s) => s.id);

describe('which snapshots go', () => {
	it('keeps the minimum whatever its size, then newer ones while they fit', () => {
		const huge = [snap(1, 4 * GB), snap(2, 4 * GB), snap(3, 4 * GB), snap(4, 4 * GB)];
		// Three always stay (12 GB, over the 10 GB budget); the fourth does not fit.
		expect(ids(snapshotsToDelete(huge, DEFAULT_POLICY))).toEqual([huge[3].id]);

		const small = Array.from({ length: 60 }, (_, i) => snap(i + 1, 50 * MB));
		// 60 x 50 MB fits in 10 GB, but 50 is the most.
		const gone = snapshotsToDelete(small, DEFAULT_POLICY);
		expect(gone).toHaveLength(10);
		expect(ids(gone)).toEqual(ids(small.slice(50).reverse()));
	});

	it('counts partial snapshots apart, so they never push out full ones, but they share the space', () => {
		const partials = Array.from({ length: 8 }, (_, i) => snap(i + 1, 1 * GB, { partial: true }));
		const fulls = [snap(20, 2 * GB), snap(21, 2 * GB), snap(22, 2 * GB), snap(23, 2 * GB)];
		const gone = snapshotsToDelete([...partials, ...fulls], DEFAULT_POLICY);
		// Guaranteed: 5 partials (5 GB) and 3 fulls (6 GB) = 11 GB, already over budget: everything else goes.
		expect(ids(gone).sort()).toEqual(ids([...partials.slice(5), fulls[3]]).sort());
	});

	it('never deletes or counts pinned ones', () => {
		const pinned = snap(100, 50 * GB, { pinned: true });
		const list = [snap(1, 3 * GB), snap(2, 3 * GB), snap(3, 3 * GB), snap(4, MB), pinned];
		expect(ids(snapshotsToDelete(list, DEFAULT_POLICY))).toEqual([]);
	});

	it('keeps at least the minimum even with no budget at all', () => {
		const list = [snap(1, MB), snap(2, MB), snap(3, MB), snap(4, MB), snap(5, MB, { partial: true })];
		const gone = snapshotsToDelete(list, { ...DEFAULT_POLICY, budgetMb: 0, partialMin: 0 });
		expect(ids(gone).sort()).toEqual(ids([list[3], list[4]]).sort());
	});
});

describe('snapshot settings', () => {
	beforeEach(() => db.delete(settings).run());

	it('turns the old single "keep" into the minimum, and fills in the rest', () => {
		db.insert(settings).values({ key: 'snapshots.policy', value: JSON.stringify({ keep: 7, askAboveMb: 512 }) }).run();
		expect(getSnapshotPolicy()).toEqual({ ...DEFAULT_POLICY, keepMin: 7, askAboveMb: 512 });
	});

	it("puts a server's own values over the global ones, field by field", () => {
		saveSnapshotPolicy({ budgetMb: 20 * 1024, keepMin: 4 });
		saveServerSnapshotOverrides('alpha', { keepMin: 10, minFreeMb: 0 });
		expect(getSnapshotPolicy('alpha')).toMatchObject({ budgetMb: 20 * 1024, keepMin: 10, minFreeMb: 0, keepMax: 50 });
		expect(getSnapshotPolicy('beta')).toMatchObject({ keepMin: 4 });
		// A max below its min is lifted to it rather than breaking the minimum.
		saveServerSnapshotOverrides('alpha', { keepMin: 60 });
		expect(getSnapshotPolicy('alpha')).toMatchObject({ keepMin: 60, keepMax: 60 });
		saveServerSnapshotOverrides('alpha', {});
		expect(getSnapshotPolicy('alpha')).toMatchObject({ keepMin: 4 });
	});

	it('reads a form: GB for sizes, blank means unset, bad values named', () => {
		const form = (fields: Record<string, string>) => {
			const f = new FormData();
			for (const [k, v] of Object.entries(fields)) f.set(k, v);
			return f;
		};
		expect(policyFromForm(form({ keepMin: '3', budgetGb: '12.5', minFreeGb: '0', askAboveMb: '', partialMax: ' ' }))).toEqual({
			fields: { keepMin: 3, budgetMb: 12800, minFreeMb: 0 },
			error: null
		});
		expect(policyFromForm(form({ keepMin: '0' })).error).toMatch(/^Full snapshots always kept/);
		expect(policyFromForm(form({ budgetGb: 'lots' })).error).toMatch(/^Storage for more/);
		expect(policyFromForm(form({ partialMin: '9', partialMax: '4' })).error).toMatch(/cannot be fewer/);
	});
});

describe('free disk space', () => {
	beforeEach(() => {
		db.delete(settings).run();
		systemdStopped();
	});
	afterEach(() => vi.restoreAllMocks());

	/** The disk has `free` bytes available. */
	const disk = (free: number) =>
		vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: free / 4096, bsize: 4096 } as Awaited<ReturnType<typeof fs.statfs>>);

	const world = () =>
		createInstance(
			{ modloader: 'fabric', minecraftVersion: '1.21.1' },
			{ 'server.properties': 'level-name=world\n', 'world/level.dat': 'x'.repeat(4096) }
		);

	it('refuses a copying snapshot that would leave less than the minimum free, and says so', async () => {
		const instance = await world();
		disk(5 * GB);
		await expect(decideSnapshot(instance, null)).rejects.toThrow(SnapshotChoiceNeeded);
		await expect(decideSnapshot(instance, 'yes')).rejects.toThrow(/Only 5.0 GB is free/);
		expect(await decideSnapshot(instance, 'no')).toBe(false);
		// Moving the old world aside takes no space: the World tab's operations still snapshot.
		expect(await decideSnapshot(instance, null, { moves: true })).toBe(true);
		await expect(takeSnapshot(instance, { reason: 'manual', label: 'x' })).rejects.toThrow(LowDiskSpaceError);
		await expect(snapshotNow(instance)).rejects.toThrow(/would leave less than/);
	});

	it('takes it when there is room, or when the check is off', async () => {
		const instance = await world();
		disk(50 * GB);
		expect(await decideSnapshot(instance, null)).toBe(true);
		vi.restoreAllMocks();
		disk(1 * GB);
		saveServerSnapshotOverrides(instance.id, { minFreeMb: 0 });
		expect(await decideSnapshot(instance, null)).toBe(true);
	});
});
