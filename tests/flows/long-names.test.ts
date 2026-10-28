import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The operations that copy a server's files, on names at what Linux allows: 255 bytes
 * (in letters that take two bytes too), characters a shell or a zip treats specially,
 * and folders nested deep. The long world (`npm run screenshots -- --long`) shows the
 * pages; this runs what those pages start.
 */

const { cloneInstance } = await import('#lib/server/instances.js');
const { LOADERS } = await import('#lib/server/modloaders.js');
const { listSnapshots } = await import('#lib/server/snapshots.js');
const { restoreSnapshot, replaceWorld, snapshotNow, zipWorlds } = await import('#lib/server/world.js');
const { buildServerExport, importServer, stageImport } = await import('#lib/server/serverbundle.js');
const { addDestination, copyBack, saveServerBackup, syncServer } = await import('#lib/server/backups.js');
const { deleteToTrash, listTrash, restoreFromTrash } = await import('#lib/server/trash.js');
const { startTask } = await import('#lib/server/tasks.js');
const { DATA_DIR, TMP_DIR } = await import('#lib/server/config.js');
const { addJava, createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');

useRecordedHttp('none');

const NAME_MAX = 255;
/** `stem` repeated to exactly `bytes` bytes of UTF-8, ending in `end`. */
function named(stem: string, bytes: number, end = ''): string {
	let out = '';
	while (Buffer.byteLength(out + stem + end) <= bytes) out += stem;
	return out + end;
}
// No backslash: a zip's entry names take it as a folder (zips made on Windows), and no
// Windows-made world can hold one.
const ODD = `odd "quoted" $HOME %20 & 'single' (1) [2] {3} #4 !5 ~6 ;7 =8 ,9 §a colour 🎮 ü`;
const DEEP = Array.from({ length: 12 }, (_, i) => named(`deep-folder-${i}-`, 200)).join('/');

const FILES: Record<string, string> = {
	'server.properties': 'level-name=world\n',
	'world/level.dat': 'level',
	[`world/${named('a', NAME_MAX)}`]: 'ascii at the limit',
	[`world/${named('ö', NAME_MAX)}`]: 'two-byte letters at the limit',
	[`world/${named('🎮', NAME_MAX)}`]: 'four-byte letters at the limit',
	[`world/${ODD}/${ODD}.dat`]: 'odd characters',
	[`world/${DEEP}/${named('d', NAME_MAX, '.mca')}`]: 'deep down',
	[`config/${named('c', NAME_MAX, '.toml')}`]: 'a config',
	[`config/${ODD}.json`]: '{}'
};

/** The files that should come through, as `tree` reads them. */
const worldFiles = () => Object.fromEntries(Object.entries(FILES).filter(([k]) => k.startsWith('world/')));
const configFiles = () => Object.fromEntries(Object.entries(FILES).filter(([k]) => k.startsWith('config/')));

async function server() {
	return createInstance({ name: named('Server ', 80).trim(), modloader: 'fabric', minecraftVersion: '1.21.1', eulaAccepted: true }, FILES);
}

describe('long and odd file names', () => {
	beforeEach(() => systemdStopped());
	afterEach(() => vi.restoreAllMocks());

	it('the test files are at the limit', () => {
		for (const rel of Object.keys(FILES)) for (const part of rel.split('/')) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(NAME_MAX);
		expect(Buffer.byteLength(named('🎮', NAME_MAX))).toBeGreaterThan(NAME_MAX - 4);
	});

	it('survive a snapshot and its restore', async () => {
		const instance = await server();
		expect((await waitForTask(await snapshotNow(instance))).state).toBe('done');
		const [snapshot] = await listSnapshots(instance.path);
		await fs.rm(path.join(instance.path, 'world'), { recursive: true });
		await fs.mkdir(path.join(instance.path, 'world'));
		await fs.writeFile(path.join(instance.path, 'world/level.dat'), 'played on');

		const task = await waitForTask(await restoreSnapshot(reload(instance.id), snapshot.id, { snapshot: false }));
		expect(task.error).toBeNull();
		expect(await tree(path.join(instance.path))).toMatchObject(worldFiles());
	});

	it('survive a world download put back as the world', async () => {
		const instance = await server();
		const file = path.join(TMP_DIR, `world-${crypto.randomUUID()}.zip`);
		await fs.mkdir(TMP_DIR, { recursive: true });
		await pipeline(await zipWorlds(instance.path, ['world']), createWriteStream(file));
		await fs.rm(path.join(instance.path, 'world'), { recursive: true });

		const task = await waitForTask(await replaceWorld(instance, file, { snapshot: false }));
		expect(task.error).toBeNull();
		expect(await tree(instance.path)).toMatchObject(worldFiles());
	});

	it('survive a server export and its import', async () => {
		const original = await server();
		const file = path.join(TMP_DIR, `export-${crypto.randomUUID()}.zip`);
		const id = startTask({ label: 'test export' }, async (task) => {
			await buildServerExport(original, { worlds: true, snapshots: false, logs: false, mapTiles: false, modBackups: false }, task, file);
		});
		expect((await waitForTask(id)).error).toBeNull();
		addJava(21);
		vi.spyOn(LOADERS.fabric, 'install').mockImplementation(async (ctx) => {
			await fs.writeFile(path.join(ctx.dir, 'server.jar'), 'fabric');
			return { launchArgs: '-jar server.jar nogui', loaderVersion: '0.16.5' };
		});

		const preview = await stageImport(file, `${ODD}.mineshell.zip`, true);
		expect(preview.name).toBe(original.name);
		const { instance, taskId } = await importServer(preview.id, { name: ODD });
		expect((await waitForTask(taskId, 10_000)).error).toBeNull();
		expect(reload(instance.id).name).toBe(ODD);
		expect(await tree(instance.path)).toMatchObject({ ...worldFiles(), ...configFiles() });
	});

	it('survive a copy of the server', async () => {
		const original = await server();
		const { instance, taskId } = await cloneInstance(original, ODD);
		expect((await waitForTask(taskId, 10_000)).error).toBeNull();
		expect(await tree(instance.path)).toMatchObject({ ...worldFiles(), ...configFiles() });
	});

	it.each([
		['plain folders', false],
		['zips', true]
	])('survive a copy to a backup folder as %s and back', async (_, compress) => {
		const dir = await fs.mkdtemp(path.join(path.dirname(DATA_DIR), 'backup-'));
		await fs.mkdir(path.join(dir, ODD));
		const destination = await addDestination({ name: ODD.slice(0, 60), path: path.join(dir, ODD), compress });
		const instance = await server();
		expect((await waitForTask(await snapshotNow(instance))).state).toBe('done');
		const [snapshot] = await listSnapshots(instance.path);
		saveServerBackup(instance.id, { destination: destination.id, copy: 'all', keep: 3 });
		await syncServer(instance.id);

		// Gone here, then copied back from the backup folder.
		await fs.rm(path.join(instance.path, '.mineshell/snapshots', snapshot.id), { recursive: true });
		expect((await waitForTask(await copyBack(reload(instance.id), snapshot.id), 10_000)).error).toBeNull();
		const back = await tree(path.join(instance.path, '.mineshell/snapshots', snapshot.id), /^\.?snapshot\.json$|^\.mineshell/);
		for (const [rel, content] of Object.entries(worldFiles())) expect(back[rel]).toBe(content);
	});

	it('survive the trash', async () => {
		const instance = await server();
		const rel = `world/${DEEP.split('/')[0]}`;
		const item = (await deleteToTrash(instance.path, rel))!;
		expect((await listTrash(instance.path)).map((t) => t.id)).toContain(item.id);
		expect(await restoreFromTrash(instance.path, item.id)).toBe(rel);
		expect(await tree(instance.path)).toMatchObject(worldFiles());
	});
});
