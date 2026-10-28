import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Copying a server to try changes on (cloneInstance). */

const { cloneInstance, rconPassword, start } = await import('#lib/server/instances.js');
const { db } = await import('#lib/server/db/index.js');
const { instanceMods, mods } = await import('#lib/server/db/schema.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { readProperties } = await import('#lib/server/properties.js');
const { createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { hangForever, restartMineShell } = await import('../helpers/crash');
const { grant, otherUser } = await import('../helpers/auth');
const { grantsOf } = await import('#lib/server/accounts.js');
const { getSnapshotSchedule, saveSnapshotSchedule, NEW_SERVER_SCHEDULE } = await import('#lib/server/snapshotschedule.js');

const FILES = {
	'server.jar': 'fabric launcher',
	'eula.txt': 'eula=true\n',
	'server.properties': 'server-port=25600\nrcon.port=25700\nenable-rcon=true\nrcon.password=old\nmotd=Pack\n',
	'world/level.dat': 'my world',
	'mods/sodium.jar': 'sodium',
	'config/sodium.json': '{}',
	'.mineshell/snapshots/2026-10-01_120000-manual/world/level.dat': 'old snapshot',
	'.mineshell/loader-previous-123/server.jar': 'leftover',
	'.mineshell/forge-backup/manifest.json': '{}'
};

async function source() {
	const instance = await createInstance(
		{
			modloader: 'fabric',
			minecraftVersion: '1.21.1',
			modloaderVersion: '0.16.5',
			serverPort: 25600,
			rconPort: 25700,
			rconPasswordEnc: encryptSecret('old'),
			packName: 'Some Pack',
			packVersionId: 'v1',
			jvmArgs: '-Xmx6G',
			pinned: true,
			eulaAccepted: true
		},
		FILES
	);
	const [mod] = db
		.insert(mods)
		.values({ source: 'modrinth', slug: `sodium-${instance.id}`, name: 'Sodium' })
		.returning()
		.all();
	db.insert(instanceMods)
		.values({ instanceId: instance.id, modId: mod.id, filePath: 'mods/sodium.jar', version: '0.6', fromPack: true, installedAt: Date.now() })
		.run();
	return instance;
}

describe('cloning a server', () => {
	beforeEach(() => systemdStopped());
	afterEach(() => vi.restoreAllMocks());

	// New servers get daily snapshots; a copy is not new in that sense and keeps its source's.
	it("gives the copy its source's snapshot schedule, none included", async () => {
		const original = await source();
		const none = await cloneInstance(original, 'No schedule');
		expect((await waitForTask(none.taskId)).state).toBe('done');
		expect(getSnapshotSchedule(none.instance.id).every).toBe('off');

		saveSnapshotSchedule(original.id, { ...NEW_SERVER_SCHEDULE, dailyTime: '02:30' });
		const daily = await cloneInstance(original, 'Daily');
		expect((await waitForTask(daily.taskId)).state).toBe('done');
		expect(getSnapshotSchedule(daily.instance.id)).toEqual({ ...NEW_SERVER_SCHEDULE, dailyTime: '02:30' });
	});

	it('copies files, settings and mod records under fresh ports and a new password', async () => {
		const original = await source();
		const before = await tree(original.path, /^$/);
		const { instance, taskId } = await cloneInstance(original, 'Trial run');
		expect((await waitForTask(taskId)).state).toBe('done');

		const copy = reload(instance.id);
		expect(copy).toMatchObject({
			name: 'Trial run',
			status: 'ready',
			modloaderVersion: '0.16.5',
			packName: 'Some Pack',
			packVersionId: 'v1',
			jvmArgs: '-Xmx6G',
			pinned: false,
			eulaAccepted: true
		});
		expect(copy.path).not.toBe(original.path);
		expect([copy.serverPort, copy.rconPort]).not.toContain(25600);
		expect(rconPassword(copy)).not.toBe('old');

		const files = await tree(copy.path, /^$/);
		expect(files['world/level.dat']).toBe('my world');
		expect(files['mods/sodium.jar']).toBe('sodium');
		expect(files['.mineshell/forge-backup/manifest.json']).toBe('{}');
		expect(Object.keys(files).some((f) => f.includes('snapshots') || f.includes('loader-previous'))).toBe(false);

		const props = (await readProperties(copy.path)).values;
		expect(props).toMatchObject({ 'server-port': String(copy.serverPort), 'rcon.port': String(copy.rconPort), motd: 'Pack' });
		expect(props['rcon.password']).toBe(rconPassword(copy));

		const rows = db.select().from(instanceMods).where(eq(instanceMods.instanceId, copy.id)).all();
		expect(rows).toMatchObject([{ filePath: 'mods/sodium.jar', version: '0.6', fromPack: true }]);
		// The original is untouched.
		expect(await tree(original.path, /^$/)).toEqual(before);
		expect(reload(original.id).serverPort).toBe(25600);
	});

	it("makes the one copying it the copy's admin, and copies nobody's access", async () => {
		const original = await source();
		const viewer = otherUser();
		const copier = otherUser();
		grant(viewer.id, original.id, { permissions: ['view'] });
		grant(copier.id, original.id, { permissions: ['duplicate', 'files'] });
		const { instance, taskId } = await cloneInstance(original, 'My copy', copier.id);
		expect((await waitForTask(taskId)).state).toBe('done');
		expect(grantsOf(copier.id)[instance.id]).toMatchObject({ admin: true });
		expect(grantsOf(viewer.id)[instance.id]).toBeUndefined();
		// What the copier had on the original stays as it was.
		expect(grantsOf(copier.id)[original.id]).toMatchObject({ admin: false, permissions: ['duplicate', 'files'] });
	});

	it('gives the same people the same access to the copy when asked', async () => {
		const original = await source();
		const viewer = otherUser();
		const copier = otherUser();
		const steve = '8667ba71-b85a-4004-af54-457a9734eed7';
		grant(viewer.id, original.id, { permissions: ['power'], playerView: [steve] });
		grant(copier.id, original.id, { permissions: ['duplicate', 'files'] });
		const { instance, taskId } = await cloneInstance(original, 'Shared copy', copier.id, true);
		expect((await waitForTask(taskId)).state).toBe('done');
		expect(grantsOf(viewer.id)[instance.id]).toMatchObject({ admin: false, permissions: ['power'], playerView: 'selected', viewUuids: [steve] });
		// The one copying it is its admin either way, with what they had kept underneath.
		expect(grantsOf(copier.id)[instance.id]).toMatchObject({ admin: true, permissions: ['duplicate', 'files'] });
	});

	it('keeps the original from starting while it is being copied', async () => {
		const original = await source();
		vi.spyOn(fs, 'cp').mockImplementation(() => hangForever());
		await cloneInstance(original, 'Busy copy');
		expect((await start(original)).message).toMatch(/being copied/);
		await expect(cloneInstance(original, 'Second copy')).rejects.toThrow(/being copied/);
	});

	it('does not adopt the folder a deleted server left behind', async () => {
		const original = await source();
		const stale = path.join(path.dirname(original.path), 'leftover-files');
		await fs.mkdir(stale, { recursive: true });
		await fs.writeFile(path.join(stale, 'old.txt'), 'someone else');
		const { instance, taskId } = await cloneInstance(original, 'Leftover files');
		await waitForTask(taskId);
		expect(instance.id).toBe('leftover-files-2');
		expect(await fs.readdir(stale)).toEqual(['old.txt']);
	});

	it('marks a copy cut short by MineShell stopping as failed', async () => {
		const original = await source();
		vi.spyOn(fs, 'cp').mockImplementation(() => hangForever());
		const { instance } = await cloneInstance(original, 'Cut short copy');
		await restartMineShell();
		expect(reload(instance.id).status).toBe('failed');
		expect(reload(original.id).status).toBe('ready');
	});
});
