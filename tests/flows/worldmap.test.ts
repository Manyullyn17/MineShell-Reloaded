import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The world map (worldmap.ts): BlueMap's CLI configured and run for a
 * server, its output served as BlueMap's own web server would. Java and
 * BlueMap are fakes; the files written and served are real.
 */

const { applyMapModConfig, installMapMod, liveMapTarget, setConfigLine, deleteMapData, evaluateMapSchedule, getMapSettings, mapStatus, mapSupport, renderMap, resolveMapFile, rollForwardMaps, saveMapSchedule, saveMapSettings, validMapSchedule, writeBlueMapConfig, mapDir } =
	await import('#lib/server/worldmap.js');
const { addJava, clearJava, createInstance, waitForTask } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');

const JAR = Buffer.from('bluemap cli');
const RELEASE = 'https://api.github.com/repos/BlueMap-Minecraft/BlueMap/releases/latest';
const JAR_URL = 'https://github.test/bluemap-5.28-cli.jar';
useRecordedHttp('none', {
	extra: {
		[RELEASE]: () =>
			Response.json({
				tag_name: 'v5.28',
				assets: [
					{ name: 'bluemap-5.28-spigot.jar', browser_download_url: 'https://github.test/spigot.jar' },
					{ name: 'bluemap-5.28-cli.jar', browser_download_url: JAR_URL, digest: `sha256:${crypto.createHash('sha256').update(JAR).digest('hex')}` }
				]
			}),
		[JAR_URL]: () => new Response(new Uint8Array(JAR)),
		// Dynmap's 1.12.2 files on the mirror: a beta newer than the last release.
		'https://api.modpacks.ch/public/mod/59433/versions/1.12.2/forge': () =>
			Response.json({
				versions: [
					{ id: 4632192, name: 'Dynmap-3.6-forge-1.12.2.jar', type: 'release', updated: 100, url: 'https://cdn.test/dynmap-3.6.jar' },
					{ id: 5442794, name: 'Dynmap-3.7-beta-6-forge-1.12.2.jar', type: 'beta', updated: 200, url: 'https://cdn.test/dynmap-3.7.jar' }
				],
				page: 1,
				pages: 1
			}),
		'https://cdn.test/dynmap-3.7.jar': () => new Response(new Uint8Array(zipBuffer({ 'mcmod.info': '[{"modid":"dynmap","name":"Dynmap"}]' }))),
		'https://dynmap.us/builds/DynmapBlockScan/DynmapBlockScan-3.4-beta-1-forge-1.12.2.jar': () =>
			new Response(new Uint8Array(zipBuffer({ 'mcmod.info': '[{"modid":"dynmapblockscan","name":"DynmapBlockScan"}]' })))
	}
});

/** A 1.21.1 server whose world has the overworld, the nether, a modded dimension and an old-style folder. */
async function server(minecraftVersion = '1.21.1') {
	return createInstance(
		{ modloader: 'neoforge', minecraftVersion },
		{
			'server.properties': 'level-name=world\n',
			'world/level.dat': 'x',
			'world/region/r.0.0.mca': 'x',
			'world/DIM-1/region/r.0.0.mca': 'x',
			'world/dimensions/twilightforest/twilight_forest/region/r.0.0.mca': 'x',
			'world/DIM7/region/r.0.0.mca': 'x',
			'mods/twilightforest.jar': 'jar'
		}
	);
}

/** systemctl says stopped; java "renders" and prints what BlueMap does. */
function blueMapRuns(output = '[12:00:00 INFO] Update: 50.0% (ETA 1 minute)\n[12:00:01 INFO] Your maps are now all up-to-date!\n', code = 0) {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemctl') return args.includes('show') ? { stdout: 'ActiveState=inactive\nSubState=dead\nResult=success\n' } : {};
		if (cmd.endsWith('/java')) return { stdout: output, code };
		return {};
	});
}

describe('the world map', () => {
	beforeEach(() => {
		clearJava();
		blueMapRuns();
	});

	it('is BlueMap for 1.13 and newer, Dynmap on Forge 1.12.2, nothing for other old worlds', () => {
		expect(mapSupport({ minecraftVersion: '1.21.1', modloader: 'neoforge' })).toEqual({ engine: 'bluemap' });
		expect(mapSupport({ minecraftVersion: '1.13', modloader: 'vanilla' })).toEqual({ engine: 'bluemap' });
		expect(mapSupport({ minecraftVersion: '1.12.2', modloader: 'cleanroom' })).toEqual({ engine: 'dynmap' });
		expect(mapSupport({ minecraftVersion: '1.12.2', modloader: 'vanilla' })).toMatchObject({ engine: null });
		expect(mapSupport({ minecraftVersion: '1.7.10', modloader: 'forge' })).toMatchObject({ engine: null });
	});

	it('configures one map per dimension BlueMap can name, and downloads only after the EULA', async () => {
		const instance = await server();
		expect(await writeBlueMapConfig(instance)).toEqual(['overworld', 'nether', 'twilightforest_twilight_forest']);
		const config = path.join(mapDir(instance.id), 'config');
		expect(await fs.readdir(path.join(config, 'maps'))).toEqual(['nether.conf', 'overworld.conf', 'twilightforest_twilight_forest.conf'].sort());
		const twilight = await fs.readFile(path.join(config, 'maps', 'twilightforest_twilight_forest.conf'), 'utf8');
		expect(twilight).toContain(`world: ${JSON.stringify(path.join(instance.path, 'world'))}`);
		expect(twilight).toContain('dimension: "twilightforest:twilight_forest"');
		expect(await fs.readFile(path.join(config, 'core.conf'), 'utf8')).toContain('accept-download: false');
		// MineShell serves the map; BlueMap's web server stays off.
		expect(await fs.readFile(path.join(config, 'webserver.conf'), 'utf8')).toBe('enabled: false\n');

		saveMapSettings(instance.id, { eulaAccepted: true });
		await writeBlueMapConfig(instance);
		expect(await fs.readFile(path.join(config, 'core.conf'), 'utf8')).toContain('accept-download: true');
	});

	it('refuses to render before the EULA is accepted', async () => {
		addJava(21);
		await expect(renderMap(await server())).rejects.toThrow(/EULA/);
	});

	it('renders with BlueMap on Java 21+, with the mods for modded blocks', async () => {
		addJava(17);
		const java = addJava(21);
		const instance = await server();
		saveMapSettings(instance.id, { eulaAccepted: true });
		const task = await waitForTask(await renderMap(instance, { force: true }));
		expect(task.state).toBe('done');
		const run = spawnCalls.find((c) => c.cmd === java)!;
		expect(run.args).toEqual([
			'-jar',
			expect.stringMatching(/tools\/bluemap\/bluemap-5\.28-cli\.jar$/),
			'-c',
			path.join(mapDir(instance.id), 'config'),
			'-r',
			'-v',
			'1.21.1',
			'-n',
			path.join(instance.path, 'mods'),
			'-f'
		]);
		expect(task.log).toContain('Your maps are now all up-to-date!');
		expect(getMapSettings(instance.id).lastRenderAt).not.toBeNull();
		// The jar is kept: the next render does not download it again.
		expect(await fs.readFile(run.args[1])).toEqual(JAR);
	});

	it('asks for Java when there is none new enough', async () => {
		addJava(17);
		const instance = await server();
		saveMapSettings(instance.id, { eulaAccepted: true });
		await expect(renderMap(instance)).rejects.toMatchObject({ major: 21 });
	});

	it('fails the task with BlueMap’s last words when it fails', async () => {
		addJava(21);
		blueMapRuns('[12:00:00 SEVERE] Failed to load world: broken\n', 1);
		const instance = await server();
		saveMapSettings(instance.id, { eulaAccepted: true });
		const task = await waitForTask(await renderMap(instance));
		expect(task.state).toBe('failed');
		expect(task.error).toMatch(/exit code 1: .*Failed to load world: broken/);
	});

	it('serves the map as BlueMap’s web server would, and nothing outside it', async () => {
		const instance = await server();
		const web = path.join(mapDir(instance.id), 'web');
		await fs.mkdir(path.join(web, 'maps/overworld/tiles/0/x0'), { recursive: true });
		await fs.writeFile(path.join(web, 'index.html'), '<html>');
		await fs.writeFile(path.join(web, 'maps/overworld/tiles/0/x0/z0.prbm.gz'), 'gz');
		await fs.writeFile(path.join(web, 'maps/overworld/textures.json.gz'), 'gz');

		expect(await resolveMapFile(instance.id, '')).toMatchObject({ file: path.join(web, 'index.html'), gzip: false, type: expect.stringMatching(/text\/html/) });
		expect(await resolveMapFile(instance.id, 'maps/overworld/tiles/0/x0/z0.prbm')).toMatchObject({ gzip: true });
		expect(await resolveMapFile(instance.id, 'maps/overworld/textures.json')).toMatchObject({ gzip: true, type: 'application/json' });
		// Not rendered there, or live data only BlueMap's own server has: nothing, not an error.
		expect(await resolveMapFile(instance.id, 'maps/overworld/tiles/0/x9/z9.prbm')).toEqual({ empty: true });
		expect(await resolveMapFile(instance.id, 'maps/overworld/live/sse')).toEqual({ empty: true });
		expect(await resolveMapFile(instance.id, 'nope.js')).toBeNull();
		expect(await resolveMapFile(instance.id, '../config/core.conf')).toBeNull();
		expect(await resolveMapFile(instance.id, '../../../etc/passwd')).toBeNull();

		expect(await mapStatus(instance)).toMatchObject({ ready: true, support: { engine: 'bluemap' } });
		await deleteMapData(instance.id, { keepSettings: true });
		expect(await mapStatus(instance)).toMatchObject({ ready: false });
	});

	it('updates on its schedule, and only then', async () => {
		addJava(21);
		const instance = await server();
		saveMapSettings(instance.id, { eulaAccepted: true });
		// Off: never.
		expect(await evaluateMapSchedule(instance)).toBeNull();

		saveMapSchedule(instance.id, validMapSchedule({ every: 'interval', intervalHours: '6' }));
		const { nextAt } = getMapSettings(instance.id);
		expect(nextAt).toBeGreaterThan(Date.now() + 5.9 * 3_600_000);
		expect(await evaluateMapSchedule(instance)).toBeNull();

		// The slot has come: one update, and the next slot set.
		const taskId = await evaluateMapSchedule(instance, nextAt! + 1000);
		expect(taskId).toEqual(expect.any(String));
		expect((await waitForTask(taskId!)).state).toBe('done');
		expect(getMapSettings(instance.id).nextAt).toBeGreaterThan(nextAt!);
	});

	it('moves a slot missed while MineShell was down to the next one instead of firing it', async () => {
		const instance = await server();
		saveMapSettings(instance.id, { eulaAccepted: true, schedule: validMapSchedule({ every: 'daily', dailyTime: '05:00' }), nextAt: Date.now() - 3_600_000 });
		rollForwardMaps();
		expect(getMapSettings(instance.id).nextAt).toBeGreaterThan(Date.now());
	});

	it('keeps schedules sane whatever is sent', () => {
		expect(validMapSchedule({ every: 'hourly', intervalHours: '0', dailyTime: '25:00' })).toEqual({ every: 'off', intervalHours: 6, dailyTime: '05:00' });
		expect(validMapSchedule({ every: 'daily', dailyTime: '23:30' })).toMatchObject({ every: 'daily', dailyTime: '23:30' });
	});

	it('sets a config line over its commented-out form, or adds it', () => {
		expect(setConfigLine('a: 1\n#webserver-bindaddress: 0.0.0.0\nb: 2\n', 'webserver-bindaddress', '127.0.0.1')).toBe('a: 1\nwebserver-bindaddress: 127.0.0.1\nb: 2\n');
		expect(setConfigLine('port: 8100\n', 'port', '8124')).toBe('port: 8124\n');
		expect(setConfigLine('a: 1', 'ip', '"127.0.0.1"')).toBe('a: 1\nip: "127.0.0.1"\n');
	});
});

describe('map mods', () => {
	beforeEach(() => blueMapRuns());

	const forge1122 = (files: Record<string, string | Buffer> = {}) =>
		createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2' }, { 'server.properties': 'level-name=world\n', ...files });

	it('installs Dynmap (its newest build) and DynmapBlockScan, then gives Dynmap its own local port', async () => {
		const instance = await forge1122();
		expect((await waitForTask(await installMapMod(instance))).state).toBe('done');
		expect((await fs.readdir(path.join(instance.path, 'mods'))).sort()).toEqual(['Dynmap-3.7-beta-6-forge-1.12.2.jar', 'DynmapBlockScan-3.4-beta-1-forge-1.12.2.jar']);
		await expect(installMapMod(instance)).rejects.toThrow(/installed already/);

		// Dynmap writes its config on its first start; from then on MineShell sets the port before each start.
		expect(await applyMapModConfig(instance)).toEqual([]);
		await fs.mkdir(path.join(instance.path, 'dynmap'));
		await fs.writeFile(path.join(instance.path, 'dynmap/configuration.txt'), '#webserver-bindaddress: 0.0.0.0\nwebserver-port: 8123\n');
		expect(await applyMapModConfig(instance)).toEqual(['dynmap/configuration.txt']);
		const port = getMapSettings(instance.id).modPort!;
		expect(await fs.readFile(path.join(instance.path, 'dynmap/configuration.txt'), 'utf8')).toBe(`webserver-bindaddress: 127.0.0.1\nwebserver-port: ${port}\n`);
		expect(await applyMapModConfig(instance)).toEqual([]);
		expect(await liveMapTarget(instance, 'up/configuration', '?x=1')).toBe(`http://127.0.0.1:${port}/up/configuration?x=1`);
		expect(await liveMapTarget(instance, '../../etc', '')).toBe(`http://127.0.0.1:${port}/etc`);

		// Another server with a map mod gets another port.
		const second = await forge1122({ 'mods/dynmap.jar': zipBuffer({ 'mcmod.info': '[{"modid":"dynmap"}]' }), 'dynmap/configuration.txt': 'webserver-port: 8123\n' });
		await applyMapModConfig(second);
		expect(getMapSettings(second.id).modPort).not.toBe(port);
	});

	it('has no live map without a map mod', async () => {
		const instance = await forge1122();
		expect(await liveMapTarget(instance, '', '')).toBeNull();
	});
});
