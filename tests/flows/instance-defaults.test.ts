import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createFromLoader, createFromPack, eulaIsAccepted } = await import('#lib/server/instances.js');
const { LOADERS } = await import('#lib/server/modloaders.js');
const { packFromFileList } = await import('#lib/server/packs/index.js');
const { readProperties } = await import('#lib/server/properties.js');
const { saveCustomPreset } = await import('#lib/server/jvm-presets.js');
const defaults = await import('#lib/server/instance-defaults.js');
const { db } = await import('#lib/server/db/index.js');
const { settings } = await import('#lib/server/db/schema.js');
const { addJava, clearJava, reload, systemdStopped, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');

const served: Record<string, () => Response> = {};
useRecordedHttp('none', { extra: served });

function fakeInstall() {
	return vi.spyOn(LOADERS.fabric, 'install').mockImplementation(async (ctx) => {
		await fs.writeFile(path.join(ctx.dir, 'server.jar'), 'fabric');
		return { launchArgs: '-jar server.jar nogui', loaderVersion: '0.16.0' };
	});
}

async function newServer(fields: { memoryMaxMb?: number; memoryMinMb?: number } = {}) {
	const { instance, taskId } = await createFromLoader({ name: 'Defaults', minecraftVersion: '1.21.1', modloader: 'fabric', ...fields });
	expect((await waitForTask(taskId)).state).toBe('done');
	return reload(instance.id);
}

describe('defaults for new servers', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(21);
		fakeInstall();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		defaults.resetInstanceDefaults();
	});

	it('uses the built-in defaults when nothing is stored', async () => {
		const row = await newServer();
		expect(row).toMatchObject({
			memoryMaxMb: defaults.suggestedMaxMb(),
			memoryMinMb: 1024,
			restartSchedule: 'none',
			autoRestartOnCrash: true,
			crashRestartLimit: 5,
			consoleBufferLines: 2000
		});
		expect(row.jvmArgs).toContain('-XX:+UseG1GC'); // Aikar's flags
		expect((await readProperties(row.path)).values).toMatchObject({ 'max-players': '10', difficulty: 'normal' });
	});

	it('applies stored memory, JVM preset, restarts, console and game settings', async () => {
		const preset = saveCustomPreset('Lean', '-XX:+UseZGC');
		defaults.setInstanceDefaults({
			...defaults.getInstanceDefaults(),
			memoryMaxMb: 6144,
			memoryMinMb: 2048,
			jvmPreset: preset.id,
			restarts: { ...defaults.BUILT_IN_DEFAULTS.restarts, restartSchedule: 'daily', restartDailyTime: '04:30', autoRestartOnCrash: false },
			console: { consoleBacklogLines: 50, consoleBufferLines: 5000 },
			properties: { ...defaults.BUILT_IN_DEFAULTS.properties, 'max-players': '4', difficulty: 'hard', 'white-list': 'true' }
		});

		const row = await newServer();
		expect(row).toMatchObject({
			memoryMaxMb: 6144,
			memoryMinMb: 2048,
			restartSchedule: 'daily',
			restartDailyTime: '04:30',
			autoRestartOnCrash: false,
			consoleBacklogLines: 50,
			consoleBufferLines: 5000
		});
		expect(row.jvmArgs).toBe('-Xms2048M -Xmx6144M -XX:+UseZGC');
		const props = (await readProperties(row.path)).values;
		expect(props).toMatchObject({ 'max-players': '4', difficulty: 'hard', 'white-list': 'true' });
		// What MineShell assigns per server is never a default.
		expect(props['server-port']).toBe(String(row.serverPort));
		expect(props.motd).toBe('Defaults');
	});

	it('lets the add-a-server form override the memory defaults', async () => {
		defaults.setInstanceDefaults({ ...defaults.getInstanceDefaults(), memoryMaxMb: 6144, memoryMinMb: 2048 });
		expect(await newServer({ memoryMaxMb: 3072, memoryMinMb: 1024 })).toMatchObject({ memoryMaxMb: 3072, memoryMinMb: 1024 });
		// Starting memory never ends up above the maximum.
		expect(await newServer({ memoryMaxMb: 1536 })).toMatchObject({ memoryMaxMb: 1536, memoryMinMb: 1536 });
	});

	it('keeps a pack’s own server.properties, filling gaps from the defaults', async () => {
		defaults.setInstanceDefaults({
			...defaults.getInstanceDefaults(),
			properties: { ...defaults.BUILT_IN_DEFAULTS.properties, difficulty: 'hard', pvp: 'false' }
		});
		served['https://files.test/defaults/overrides.zip'] = () =>
			new Response(new Uint8Array(zipBuffer({ 'overrides/server.properties': 'difficulty=peaceful\n' })));
		const pack = packFromFileList({
			name: 'P', version: '1', minecraftVersion: '1.21.1', modloader: 'fabric', modloaderVersion: null,
			files: [{ path: './', name: 'overrides.zip', url: 'https://files.test/defaults/overrides.zip' }]
		});
		const { instance, taskId } = await createFromPack('Pack', pack, { source: 'curseforge' });
		await waitForTask(taskId);
		expect((await readProperties(instance.path)).values).toMatchObject({ difficulty: 'peaceful', pvp: 'false' });
	});
});

function storeRaw(value: string) {
	defaults.resetInstanceDefaults();
	db.insert(settings).values({ key: 'instance.defaults', value }).run();
}

describe('stored defaults', () => {
	afterEach(() => defaults.resetInstanceDefaults());

	it('only stores game settings that differ from the built-in ones', () => {
		defaults.setInstanceDefaults({
			...defaults.getInstanceDefaults(),
			properties: { ...defaults.BUILT_IN_DEFAULTS.properties, 'max-players': '4' }
		});
		const row = db.select().from(settings).all().find((r) => r.key === 'instance.defaults')!;
		expect(JSON.parse(row.value).properties).toEqual({ 'max-players': '4' });
	});

	it('reads a broken or out-of-range row as the nearest valid defaults', () => {
		storeRaw(
			JSON.stringify({
				memoryMinMb: 'lots',
				jvmPreset: 'deleted-preset',
				restarts: { restartSchedule: 'hourly', crashRestartLimit: 9999, restartDailyTime: '25:00' },
				console: { consoleBufferLines: 5 },
				properties: { difficulty: 'impossible', 'max-players': '99999', 'level-seed': 'not defaultable', pvp: 'yes' }
			})
		);
		const d = defaults.getInstanceDefaults();
		expect(d).toMatchObject({ memoryMaxMb: null, memoryMinMb: 1024, jvmPreset: 'aikar' });
		expect(d.restarts).toMatchObject({ restartSchedule: 'none', crashRestartLimit: 50, restartDailyTime: '05:00' });
		expect(d.console.consoleBufferLines).toBe(100);
		expect(d.properties).toMatchObject({ difficulty: 'normal', 'max-players': '2000', pvp: 'true' });
		expect(d.properties['level-seed']).toBeUndefined();

		storeRaw('{not json');
		expect(defaults.getInstanceDefaults()).toEqual(defaults.BUILT_IN_DEFAULTS);
	});
});

describe('choices made when adding a server', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(21);
		fakeInstall();
	});
	afterEach(() => vi.restoreAllMocks());

	it('uses the game port asked for, with an RCON port of its own', async () => {
		const { instance, taskId } = await createFromLoader({ name: 'Port', minecraftVersion: '1.21.1', modloader: 'fabric', serverPort: 25901 });
		expect((await waitForTask(taskId)).state).toBe('done');
		const row = reload(instance.id);
		expect(row.serverPort).toBe(25901);
		expect(row.rconPort).not.toBe(25901);
		expect((await readProperties(row.path)).values['server-port']).toBe('25901');
	});

	it('refuses a port another server has, before creating anything', async () => {
		const { instance, taskId } = await createFromLoader({ name: 'First', minecraftVersion: '1.21.1', modloader: 'fabric', serverPort: 25902 });
		await waitForTask(taskId);
		const before = (await fs.readdir(path.dirname(instance.path))).length;
		await expect(
			createFromLoader({ name: 'Second', minecraftVersion: '1.21.1', modloader: 'fabric', serverPort: 25902 })
		).rejects.toThrow(/already uses port 25902/);
		expect((await fs.readdir(path.dirname(instance.path))).length).toBe(before);
	});

	it('accepts the EULA ticked on the form at once, so the page does not ask while it installs', async () => {
		const { instance, taskId } = await createFromLoader({ name: 'Eula', minecraftVersion: '1.21.1', modloader: 'fabric', acceptEula: true });
		expect(await eulaIsAccepted(instance)).toBe(true);
		expect(reload(instance.id).eulaAccepted).toBe(true);
		expect((await waitForTask(taskId)).state).toBe('done');
		expect(await fs.readFile(path.join(instance.path, 'eula.txt'), 'utf8')).toMatch(/eula=true/);
	});

	it("accepts it for a pack too, and again after the pack's own eula.txt", async () => {
		served['https://files.test/eula/overrides.zip'] = () =>
			new Response(new Uint8Array(zipBuffer({ 'overrides/eula.txt': 'eula=false\n' })));
		const pack = packFromFileList({
			name: 'P', version: '1', minecraftVersion: '1.21.1', modloader: 'fabric', modloaderVersion: null,
			files: [{ path: './', name: 'overrides.zip', url: 'https://files.test/eula/overrides.zip' }]
		});
		const { instance, taskId } = await createFromPack('Eula pack', pack, { source: 'curseforge' }, { acceptEula: true });
		expect(await eulaIsAccepted(instance)).toBe(true);
		expect((await waitForTask(taskId)).state).toBe('done');
		expect(await eulaIsAccepted(instance)).toBe(true);
	});
});
