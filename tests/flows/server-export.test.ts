import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Moving a server to another MineShell: export to one zip, import from it (serverbundle.ts). */

const { buildServerExport, bundleCategory, checkedSettings, importServer, readManifest, stageImport, MANIFEST } = await import(
	'#lib/server/serverbundle.js'
);
const { LOADERS } = await import('#lib/server/modloaders.js');
const { db } = await import('#lib/server/db/index.js');
const { instanceDatapacks, instanceMods, instanceTags, mods, serverTags } = await import('#lib/server/db/schema.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { readProperties } = await import('#lib/server/properties.js');
const { getMacros, setMacros } = await import('#lib/server/macros.js');
const { addScheduledCommand, listScheduledCommands } = await import('#lib/server/scheduledcommands.js');
const { addCustomField, listCustomFields } = await import('#lib/server/playerfields.js');
const { assignServerTag, createOrFindServerTag } = await import('#lib/server/servertags.js');
const { readMissing } = await import('#lib/server/packs/missing.js');
const { startTask } = await import('#lib/server/tasks.js');
const { TMP_DIR } = await import('#lib/server/config.js');
const { addJava, clearJava, createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');
const { zipEntryNames } = await import('#lib/server/zip.js');

const sha512 = (s: string) => crypto.createHash('sha512').update(s).digest('hex');

/** What the fake Modrinth and CurseForge hosts serve, by URL. */
const served: Record<string, () => Response> = {};
useRecordedHttp('none', { extra: served });

// Sodium is on Modrinth: the export finds it by its hash and links it.
const SODIUM = 'sodium bytes';
served['https://api.modrinth.com/v2/version_files'] = () =>
	Response.json({
		[sha512(SODIUM)]: {
			id: 'v-sodium',
			project_id: 'AANobbMI',
			name: 'Sodium 0.6',
			version_number: '0.6',
			version_type: 'release',
			date_published: '2026-01-01',
			game_versions: ['1.21.1'],
			loaders: ['fabric'],
			changelog: '',
			dependencies: [],
			files: [{ filename: 'sodium.jar', url: 'https://cdn.modrinth.com/data/sodium.jar', primary: true, size: SODIUM.length, hashes: { sha512: sha512(SODIUM) } }]
		}
	});
served['https://cdn.modrinth.com/data/sodium.jar'] = () => new Response(SODIUM);
// A CurseForge mod, resolved through the modpacks.ch mirror by its project and file id.
const CF = 'curseforge mod bytes';
served['https://api.modpacks.ch/public/mod/123'] = () =>
	Response.json({
		id: 123,
		name: 'Iron Things',
		synopsis: '',
		art: [],
		links: [],
		versions: [{ id: 4567, name: 'iron-things-2.0.jar', version: '2.0', url: 'https://files.test/cf/iron-things-2.0.jar', sha1: crypto.createHash('sha1').update(CF).digest('hex'), targets: [] }]
	});
served['https://files.test/cf/iron-things-2.0.jar'] = () => new Response(CF);

const FILES: Record<string, string> = {
	// The loader's own: installed again on import, never in the export.
	'server.jar': 'fabric launcher',
	'libraries/net/fabricmc/loader.jar': 'loader',
	'.fabric-cache/vanilla.jar': 'vanilla, cached by the Fabric install',
	'versions/1.21.1/server-1.21.1.jar': 'unpacked by the vanilla server',
	'eula.txt': 'eula=true\n',
	'server.properties': 'server-port=25610\nrcon.port=25710\nenable-rcon=true\nrcon.password=old\nlevel-name=world\nmotd=Home\n',
	'world/level.dat': 'my world',
	'world/region/r.0.0.mca': 'chunks',
	'world/session.lock': 'lock',
	'world_nether/DIM-1/region/r.0.0.mca': 'nether',
	'creative/level.dat': 'another world',
	'mods/sodium.jar': SODIUM,
	'mods/iron-things-2.0.jar': CF,
	'mods/own-build.jar': 'only here',
	'mods/old.jar.disabled': 'switched off',
	'config/sodium.json': '{"fast":true}',
	'whitelist.json': '[]',
	'logs/latest.log': 'log',
	'dynmap/web/tiles/a.png': 'tile',
	'.mineshell/snapshots/2026-10-01_120000-manual/world/level.dat': 'old snapshot',
	'.mineshell/forge-backup/manifest.json': '{}',
	'.mineshell/worlds.json': '{"worlds":{"creative":{"name":"Creative"}}}'
};

async function source() {
	const instance = await createInstance(
		{
			name: 'Home',
			modloader: 'fabric',
			minecraftVersion: '1.21.1',
			modloaderVersion: '0.16.5',
			serverPort: 25610,
			rconPort: 25710,
			rconPasswordEnc: encryptSecret('old'),
			packSource: 'modrinth',
			packProjectId: 'abc',
			packVersionId: 'v1',
			packVersionName: '1.0',
			packName: 'Some Pack',
			jvmArgs: '-Xms2G -Xmx6G -XX:+UseG1GC',
			memoryMaxMb: 6144,
			memoryMinMb: 2048,
			restartSchedule: 'daily',
			restartDailyTime: '04:30',
			limitCpuPercent: 400,
			notes: 'Our server',
			eulaAccepted: true
		},
		FILES
	);
	const tag = (relPath: string, row: { source: string; slug: string; name: string }, extra: Record<string, unknown> = {}) => {
		const [mod] = db.insert(mods).values(row).onConflictDoNothing().returning().all();
		const id = mod?.id ?? db.select().from(mods).where(eq(mods.slug, row.slug)).get()!.id;
		db.insert(instanceMods).values({ instanceId: instance.id, modId: id, filePath: relPath, installedAt: 1, ...extra }).run();
	};
	tag('mods/sodium.jar', { source: 'modrinth', slug: `sodium-${instance.id}`, name: 'Sodium' }, { version: '0.6', fromPack: true });
	tag('mods/iron-things-2.0.jar', { source: 'curseforge', slug: '123', name: 'Iron Things' }, { version: '2.0', versionId: '4567', locked: true });
	tag('mods/own-build.jar', { source: 'manual', slug: `own-build-${instance.id}.jar`, name: 'Own build' });
	tag('mods/old.jar.disabled', { source: 'manual', slug: `old-${instance.id}.jar`, name: 'Old' }, { enabled: false });
	addScheduledCommand(instance.id, 'say hello', { dailyTime: '18:00' });
	setMacros(instance.id, ['weather clear']);
	addCustomField(instance.id, { label: 'Mana', kind: 'number', path: ['ForgeCaps', 'mana'] });
	assignServerTag(instance.id, createOrFindServerTag(`Friends-${instance.id}`)!.id);
	db.insert(instanceDatapacks)
		.values({ instanceId: instance.id, source: 'modrinth', projectId: 'dp', slug: 'dp', name: 'Terralith', fileName: 'terralith.zip', installedAt: 1 })
		.run();
	return instance;
}

function fakeInstall() {
	return vi.spyOn(LOADERS.fabric, 'install').mockImplementation(async (ctx) => {
		await fs.writeFile(path.join(ctx.dir, 'server.jar'), 'fresh fabric launcher');
		return { launchArgs: '-jar server.jar nogui', loaderVersion: ctx.loaderVersion ?? 'latest' };
	});
}

/** The export of `instance` as a file, built the way the task builds it. */
async function exportOf(instance: Awaited<ReturnType<typeof source>>, choices = { worlds: true, snapshots: false, logs: false, mapTiles: false }) {
	const file = path.join(TMP_DIR, `export-${crypto.randomUUID()}.zip`);
	let manifest: Awaited<ReturnType<typeof buildServerExport>> | null = null;
	const id = startTask({ label: 'test export' }, async (task) => {
		manifest = await buildServerExport(instance, choices, task, file);
	});
	const done = await waitForTask(id);
	if (done.state !== 'done') throw new Error(done.error ?? 'export failed');
	return { file, manifest: manifest! };
}

describe('exporting a server', () => {
	beforeEach(() => systemdStopped());
	afterEach(() => vi.restoreAllMocks());

	it('links mods it can download again and carries everything else, without the loader, logs, snapshots or map tiles', async () => {
		const { file, manifest } = await exportOf(await source());
		const names = (await zipEntryNames(file))!;
		expect(names[0]).toBe(MANIFEST);
		const files = names.filter((n) => n.startsWith('files/')).map((n) => n.slice('files/'.length)).sort();
		expect(files).toEqual([
			'.mineshell/forge-backup/manifest.json',
			'.mineshell/worlds.json',
			'config/sodium.json',
			'creative/level.dat',
			'mods/old.jar.disabled',
			'mods/own-build.jar',
			'server.properties',
			'whitelist.json',
			'world/level.dat',
			'world/region/r.0.0.mca',
			'world_nether/DIM-1/region/r.0.0.mca'
		]);
		expect(manifest.downloads.map((d) => d.target).sort()).toEqual(['mods/iron-things-2.0.jar', 'mods/sodium.jar']);
		expect(manifest.downloads.find((d) => d.target === 'mods/sodium.jar')).toMatchObject({ urls: ['https://cdn.modrinth.com/data/sodium.jar'], hash: { algo: 'sha512' } });
		expect(manifest.downloads.find((d) => d.target === 'mods/iron-things-2.0.jar')).toMatchObject({ urls: [], curseforge: { projectId: 123, fileId: 4567 } });
		expect(manifest.server.settings).toMatchObject({ jvmArgs: '-Xms2G -Xmx6G -XX:+UseG1GC', restartDailyTime: '04:30', notes: 'Our server' });
		// What belongs to the machine is not in it.
		const text = JSON.stringify(manifest);
		expect(text).not.toContain('25610');
		expect(text).not.toContain(encryptSecret('old').slice(0, 5));
		expect(manifest.server.settings).not.toHaveProperty('javaPath');
	});

	it('takes logs, snapshots and map tiles when asked, and leaves the worlds out when asked', async () => {
		const { file } = await exportOf(await source(), { worlds: false, snapshots: true, logs: true, mapTiles: true });
		const files = (await zipEntryNames(file))!.filter((n) => n.startsWith('files/')).map((n) => n.slice('files/'.length));
		expect(files).toEqual(expect.arrayContaining(['logs/latest.log', 'dynmap/web/tiles/a.png', '.mineshell/snapshots/2026-10-01_120000-manual/world/level.dat']));
		expect(files.some((f) => f.startsWith('world/') || f.startsWith('world_nether/') || f.startsWith('creative/'))).toBe(false);
	});

	it('sorts the server folder into what an export takes', () => {
		const tops = new Set(['world', 'world_nether']);
		expect(bundleCategory('libraries/a/b.jar', tops)).toBe('never');
		expect(bundleCategory('cleanroom-0.5.17.jar', tops)).toBe('never');
		expect(bundleCategory('.mineshell/pack-change-123/x', tops)).toBe('never');
		expect(bundleCategory('world/session.lock', tops)).toBe('never');
		expect(bundleCategory('world_nether/DIM-1/x', tops)).toBe('worlds');
		expect(bundleCategory('crash-reports/a.txt', tops)).toBe('logs');
		expect(bundleCategory('config/a.toml', tops)).toBe('always');
	});
});

describe('importing a server', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(21);
	});
	afterEach(() => vi.restoreAllMocks());

	it('installs the same loader, unpacks the files, downloads the linked mods and restores settings and records', async () => {
		const original = await source();
		const { file } = await exportOf(original);
		const install = fakeInstall();
		const preview = await stageImport(file, 'home.mineshell.zip', true);
		expect(preview).toMatchObject({ name: 'Home', minecraftVersion: '1.21.1', modloader: 'fabric', modloaderVersion: '0.16.5', mods: 4, downloads: 2 });

		const { instance, taskId } = await importServer(preview.id, { name: 'Home again' });
		const task = await waitForTask(taskId);
		expect(task.error).toBeNull();
		expect(install).toHaveBeenCalledWith(expect.objectContaining({ minecraftVersion: '1.21.1', loaderVersion: '0.16.5' }));

		const copy = reload(instance.id);
		expect(copy).toMatchObject({
			name: 'Home again',
			status: 'ready',
			packName: 'Some Pack',
			packVersionId: 'v1',
			jvmArgs: '-Xms2G -Xmx6G -XX:+UseG1GC',
			memoryMaxMb: 6144,
			restartSchedule: 'daily',
			restartDailyTime: '04:30',
			limitCpuPercent: 400,
			notes: 'Our server'
		});
		// This machine's ports and password, not the export's.
		expect(copy.serverPort).not.toBe(25610);
		const props = (await readProperties(copy.path)).values;
		expect(props).toMatchObject({ 'server-port': String(copy.serverPort), 'rcon.port': String(copy.rconPort), motd: 'Home' });
		expect(props['rcon.password']).not.toBe('old');

		const files = await tree(copy.path, /^$/);
		expect(files).toMatchObject({
			'server.jar': 'fresh fabric launcher',
			'mods/sodium.jar': SODIUM,
			'mods/iron-things-2.0.jar': CF,
			'mods/own-build.jar': 'only here',
			'mods/old.jar.disabled': 'switched off',
			'world/level.dat': 'my world',
			'creative/level.dat': 'another world',
			'config/sodium.json': '{"fast":true}'
		});
		expect(files).not.toHaveProperty(['libraries/net/fabricmc/loader.jar']);
		expect(files).not.toHaveProperty(['logs/latest.log']);
		expect(files).not.toHaveProperty(['eula.txt']);

		const rows = db
			.select({ filePath: instanceMods.filePath, source: mods.source, enabled: instanceMods.enabled, locked: instanceMods.locked, fromPack: instanceMods.fromPack, versionId: instanceMods.versionId })
			.from(instanceMods)
			.innerJoin(mods, eq(mods.id, instanceMods.modId))
			.where(eq(instanceMods.instanceId, copy.id))
			.all()
			.sort((a, b) => a.filePath.localeCompare(b.filePath));
		expect(rows).toEqual([
			{ filePath: 'mods/iron-things-2.0.jar', source: 'curseforge', enabled: true, locked: true, fromPack: false, versionId: '4567' },
			{ filePath: 'mods/old.jar.disabled', source: 'manual', enabled: false, locked: false, fromPack: false, versionId: null },
			{ filePath: 'mods/own-build.jar', source: 'manual', enabled: true, locked: false, fromPack: false, versionId: null },
			{ filePath: 'mods/sodium.jar', source: 'modrinth', enabled: true, locked: false, fromPack: true, versionId: null }
		]);
		expect(listScheduledCommands(copy.id)).toMatchObject([{ command: 'say hello', dailyTime: '18:00' }]);
		expect(getMacros(copy.id)).toEqual(['weather clear']);
		expect(listCustomFields(copy.id)).toMatchObject([{ label: 'Mana', kind: 'number', path: ['ForgeCaps', 'mana'] }]);
		expect(db.select().from(instanceDatapacks).where(eq(instanceDatapacks.instanceId, copy.id)).all()).toMatchObject([{ name: 'Terralith', fileName: 'terralith.zip' }]);
		const tags = db.select({ name: serverTags.name }).from(instanceTags).innerJoin(serverTags, eq(serverTags.id, instanceTags.tagId)).where(eq(instanceTags.instanceId, copy.id)).all();
		expect(tags).toEqual([{ name: `Friends-${original.id}` }]);
		// The uploaded copy is gone once imported.
		await expect(fs.access(file)).rejects.toThrow();
	});

	it('lists a mod that cannot be downloaded as missing, to fetch later, and still finishes', async () => {
		const original = await source();
		const { file } = await exportOf(original);
		fakeInstall();
		const saved = served['https://cdn.modrinth.com/data/sodium.jar'];
		served['https://cdn.modrinth.com/data/sodium.jar'] = () => new Response('gone', { status: 404 });
		try {
			const preview = await stageImport(file, 'home.zip', true);
			const { instance, taskId } = await importServer(preview.id, { name: 'Missing one' });
			expect((await waitForTask(taskId)).state).toBe('done');
			expect(reload(instance.id).statusMessage).toMatch(/could not be downloaded/i);
			expect((await readMissing(reload(instance.id).path)).map((m) => m.name)).toEqual(['sodium.jar']);
		} finally {
			served['https://cdn.modrinth.com/data/sodium.jar'] = saved;
		}
	});

	it('refuses a file that is no export, and one from a newer MineShell', async () => {
		const plain = path.join(TMP_DIR, `plain-${crypto.randomUUID()}.zip`);
		const { zipBuffer } = await import('../helpers/fs');
		await fs.writeFile(plain, await zipBuffer({ 'world/level.dat': 'x' }));
		await expect(stageImport(plain, 'plain.zip', false)).rejects.toThrow(/not a MineShell server export/);

		const newer = path.join(TMP_DIR, `newer-${crypto.randomUUID()}.zip`);
		await fs.writeFile(newer, await zipBuffer({ [MANIFEST]: JSON.stringify({ format: 99, mineshell: '9.0.0', server: { minecraftVersion: '1.21.1' } }) }));
		await expect(readManifest(newer)).rejects.toThrow(/newer MineShell \(9\.0\.0\)/);
		// A file on this machine (not an upload) is left where it is.
		await expect(fs.access(plain)).resolves.toBeUndefined();
	});

	it('keeps only settings that pass the settings pages\' checks', () => {
		expect(
			checkedSettings({ memoryMaxMb: 4096, memoryMinMb: 8192, restartDailyTime: '25:00', updateChannel: 'nightly', bootStart: 'always', jvmArgs: '-Xmx4G\n-evil', serverPort: 1, javaPath: '/x' })
		).toEqual({ memoryMaxMb: 4096, bootStart: 'always' });
	});

	it('turns away an export with a file outside the server folder before anything is created', async () => {
		const evil = path.join(TMP_DIR, `evil-${crypto.randomUUID()}.zip`);
		const { zipBuffer } = await import('../helpers/fs');
		await fs.writeFile(evil, await zipBuffer({ [MANIFEST]: JSON.stringify({ format: 1, server: { minecraftVersion: '1.21.1' } }), 'files/../escaped.txt': 'x' }));
		await expect(stageImport(evil, 'evil.zip', true)).rejects.toThrow(/cannot be imported/);
	});

	it('downloads nothing to a place outside the server folder', async () => {
		const evil = path.join(TMP_DIR, `evil-${crypto.randomUUID()}.zip`);
		const { zipBuffer } = await import('../helpers/fs');
		const manifest = {
			format: 1,
			mineshell: '0.25.0',
			exportedAt: 1,
			server: { name: 'Evil', minecraftVersion: '1.21.1', modloader: 'fabric', modloaderVersion: '0.16.5', pack: null, settings: {} },
			included: { worlds: true, snapshots: false, logs: false, mapTiles: false },
			downloads: [{ target: '../../outside.jar', urls: ['https://cdn.modrinth.com/data/sodium.jar'], hash: null, required: true, size: 1 }],
			files: 2,
			bytes: 2,
			records: {}
		};
		await fs.writeFile(evil, await zipBuffer({ [MANIFEST]: JSON.stringify(manifest), 'files/config/ok.txt': 'ok' }));
		fakeInstall();
		const preview = await stageImport(evil, 'evil.zip', true);
		const { instance, taskId } = await importServer(preview.id, { name: 'Evil' });
		expect((await waitForTask(taskId)).state).toBe('done');
		const files = await tree(reload(instance.id).path, /^$/);
		expect(files).toHaveProperty(['config/ok.txt']);
		await expect(fs.access(path.join(path.dirname(reload(instance.id).path), '..', 'outside.jar'))).rejects.toThrow();
	});
});
