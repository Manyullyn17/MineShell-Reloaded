import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The world map (worldmap.ts): BlueMap's CLI configured and run for a
 * server, its output served as BlueMap's own web server would. Java and
 * BlueMap are fakes; the files written and served are real.
 */

const { deleteMapData, getMapSettings, mapStatus, mapSupport, renderMap, resolveMapFile, saveMapSettings, writeBlueMapConfig, mapDir } =
	await import('#lib/server/worldmap.js');
const { addJava, clearJava, createInstance, waitForTask } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { useRecordedHttp } = await import('../helpers/http');

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
		[JAR_URL]: () => new Response(new Uint8Array(JAR))
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

	it('is BlueMap for 1.13 and newer, nothing yet for older worlds', () => {
		expect(mapSupport({ minecraftVersion: '1.21.1', modloader: 'neoforge' })).toEqual({ engine: 'bluemap' });
		expect(mapSupport({ minecraftVersion: '1.13', modloader: 'vanilla' })).toEqual({ engine: 'bluemap' });
		expect(mapSupport({ minecraftVersion: '1.12.2', modloader: 'cleanroom' })).toMatchObject({ engine: null, reason: expect.stringMatching(/Dynmap/) });
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
});
