import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseLog, diagnoseRun, duplicateMods, indexMods, raisedTickLimit, requiredBy, type ModJar } from '#lib/server/crashdiag.js';
import { mcmodInfo, tempDir, writeJar, zipBuffer } from '../helpers/fs';

/**
 * Recorded crashes (see README.md): each fixture is a failed start's console
 * output plus a trimmed index of the mods folder it ran with. The expected
 * diagnosis must come first and be marked fatal.
 */
const here = path.dirname(new URL(import.meta.url).pathname);
type Case = { name: string; kind: string; culprit: string; related?: string };
const cases: Case[] = JSON.parse(await fs.readFile(path.join(here, 'cases.json'), 'utf8'));

describe('recorded crashes', () => {
	it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
		const log = await fs.readFile(path.join(here, 'fixtures', `${c.name}.log`), 'utf8');
		const raw = JSON.parse(await fs.readFile(path.join(here, 'fixtures', `${c.name}.mods.json`), 'utf8'));
		const mods: ModJar[] = raw.map((j: ModJar & { classes: string[] }) => ({ ...j, classes: new Set(j.classes) }));

		const [top, ...rest] = diagnoseLog(log, mods);
		expect(top, `nothing diagnosed; also found: ${rest.map((d) => d.title).join(' | ')}`).toBeDefined();
		expect(top.kind).toBe(c.kind);
		expect(top.fatal).toBe(true);
		expect(top.culprit?.name ?? '').toMatch(new RegExp(c.culprit, 'i'));
		if (c.related) expect(`${top.related?.name ?? ''} ${top.related?.fileName ?? ''}`).toMatch(new RegExp(c.related, 'i'));
	});
});

describe('memory kills', () => {
	// systemd's own lines, as journalctl -o cat prints them for a unit past MemoryMax.
	const log = [
		'Started minecraft@pack.service - Minecraft server (pack) managed by MineShell.',
		'[10:00:01] [main/ERROR] [mixin]: Mixin apply for mod somemod failed somemod.mixins.json:FooMixin from mod somemod -> net.minecraft.Foo',
		'[10:00:30] [Server thread/INFO] [minecraft/DedicatedServer]: Done (8.364s)! For help, type "help" or "?"',
		'minecraft@pack.service: A process of this unit has been killed by the OOM killer.',
		'minecraft@pack.service: Main process exited, code=killed, status=9/KILL',
		"minecraft@pack.service: Failed with result 'oom-kill'."
	].join('\n');

	it('names the memory limit as the cause, before errors logged earlier', () => {
		const [top, ...rest] = diagnoseLog(log, [], { memoryLimitMb: 17408 });
		expect(top.kind).toBe('memory-killed');
		expect(top.fatal).toBe(true);
		expect(top.title).toContain('17408 MB');
		expect(rest.every((d) => !d.fatal)).toBe(true);
	});

	it('says the machine ran out when the server has no limit', () => {
		const [top] = diagnoseLog(log, []);
		expect(top.kind).toBe('memory-killed');
		expect(top.title).toBe('Killed for running out of memory');
	});
});

describe('watchdog stops', () => {
	// Recorded from vanilla with max-tick-time=1 (tests/tools/mc-probe.mjs): 1.21.11, then 1.12.2.
	const modern = [
		'Started minecraft@pack.service - Minecraft server (pack) managed by MineShell.',
		'[18:17:26] [Server thread/INFO]: Done (1.502s)! For help, type "help"',
		'[18:17:26] [Server thread/INFO]: Saving the game (this may take a moment!)',
		'[18:17:26] [Server Watchdog/ERROR]: A single server tick took 61.20 seconds (should be max 0.05)',
		'[18:17:26] [Server Watchdog/ERROR]: Considering it to be crashed, server will forcibly shutdown.',
		'[18:17:27] [Server Watchdog/ERROR]: This crash report has been saved to: <instance>/crash-reports/crash-2026-10-28_18.17.27-server.txt'
	].join('\n');
	const legacy =
		'[18:19:48] [Server Watchdog/FATAL]: A single server tick took 60,03 seconds (should be max 0.05)\n' +
		'[18:19:48] [Server Watchdog/FATAL]: Considering it to be crashed, server will forcibly shutdown.';

	it('names the watchdog and offers the next limit: 3 minutes from the 1 Minecraft uses, then 10', () => {
		const [top] = diagnoseLog(modern, []);
		expect(top).toMatchObject({ kind: 'watchdog', fatal: true, title: 'Stopped by the watchdog: one tick took 61 s', tickLimit: { ms: 180_000, label: 'Allow ticks up to 3 minutes' } });
		expect(diagnoseLog(legacy, [], { maxTickTimeMs: 60_000 })[0]).toMatchObject({ kind: 'watchdog', tickLimit: { ms: 180_000 } });
		// A limit raised to 3 minutes before, and the tick ran past that too.
		const again = modern.replace('61.20', '181.00');
		expect(diagnoseLog(again, [], { maxTickTimeMs: 180_000 })[0].tickLimit).toEqual({ ms: 600_000, label: 'Allow ticks up to 10 minutes' });
		expect([raisedTickLimit(null), raisedTickLimit(90_000), raisedTickLimit(180_000), raisedTickLimit(600_000), raisedTickLimit(-1)]).toEqual([180_000, 180_000, 600_000, null, null]);
	});

	it('offers nothing higher past 10 minutes, where a tick is stuck rather than slow', () => {
		const [top] = diagnoseLog(modern.replace('61.20', '601.00'), [], { maxTickTimeMs: 600_000 });
		expect(top.tickLimit).toBeNull();
		expect(top.detail).toMatch(/hung/);
		expect(top.detail).toMatch(/-1 turns the watchdog off/);
	});

	it('says so when the limit was raised since that run', () => {
		const [top] = diagnoseLog(modern, [], { maxTickTimeMs: 180_000 });
		expect(top.tickLimit).toBeNull();
		expect(top.detail).toMatch(/^The limit is 3 minutes now, raised since/);
	});

	it("names the mod whose code was running, from the crash report's stack, only inside crash-reports/", async () => {
		const dir = await tempDir();
		await writeJar(path.join(dir, 'mods'), 'create.jar', {
			'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="create"\ndisplayName="Create"\n',
			'com/simibubi/create/content/Contraption.class': 'x'
		});
		await fs.writeFile(path.join(dir, 'server.properties'), 'max-tick-time=60000\n');
		await fs.mkdir(path.join(dir, 'crash-reports'));
		const report = [
			'---- Minecraft Crash Report ----',
			'Description: Watching Server',
			'',
			'java.lang.Error: Watchdog',
			'\tat java.base@21.0.12.1/java.util.concurrent.locks.LockSupport.park(LockSupport.java:221)',
			'\tat TRANSFORMER/create@6.0.4/com.simibubi.create.content.Contraption.tick(Contraption.java:120)',
			'\tat TRANSFORMER/minecraft@1.20.1/net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:900)',
			'',
			'A detailed walkthrough of the error, its code path and all known details is as follows:'
		].join('\n');
		await fs.writeFile(path.join(dir, 'crash-reports', 'crash-2026-10-28_18.17.27-server.txt'), report);
		const log = modern.replace('<instance>', `${dir}/.`);

		const [top] = await diagnoseRun(log, path.join(dir, 'mods'));
		expect(top).toMatchObject({ kind: 'watchdog', culprit: { name: 'Create' }, tickLimit: { ms: 180_000 } });
		expect(top.detail).toContain("Create's code was running");

		// A report the log names outside the server's crash-reports/ is not read.
		await fs.writeFile(path.join(dir, 'elsewhere.txt'), report);
		const [outside] = await diagnoseRun(modern.replace(/<instance>\/crash-reports\/\S+/, `${dir}/crash-reports/../elsewhere.txt`), path.join(dir, 'mods'));
		expect(outside.culprit).toBeNull();
	});
});

describe('chat in the log', () => {
	const sodium: ModJar = { fileName: 'sodium.jar', enabled: true, ids: ['sodium'], provides: [], names: ['Sodium'], version: '0.5.8', authors: [], clientOnly: false, requires: [], classes: new Set(), mixinConfigs: [], logo: null };
	const missing = "Mod 'Sodium' (sodium) 0.5.8 requires any version of mod 'fabric-api', which is missing!";
	const run = (message: string) =>
		[
			'Started minecraft@pack.service - Minecraft server (pack) managed by MineShell.',
			'[10:00:30] [Server thread/INFO]: Done (8.364s)! For help, type "help" or "?"',
			`[10:05:00] [Server thread/INFO]: ${message}`,
			'[10:06:00] [Server thread/ERROR]: Encountered an unexpected exception'
		].join('\n');

	// A diagnosis can offer to disable the mod it blames: a player must not be able to pick it.
	it('is not read as the loader saying something', () => {
		expect(diagnoseLog(run(`<Steve> ${missing}`), [sodium])).toEqual([]);
		expect(diagnoseLog(run(`[Not Secure] <Steve> ${missing}`), [sodium])).toEqual([]);
		expect(diagnoseLog(run(missing), [sodium])[0]?.culprit?.name).toBe('Sodium');
	});
});

describe('indexMods', () => {
	it('reads every loader metadata format, client-only flags and jar-in-jar classes', async () => {
		const dir = await tempDir();
		await writeJar(dir, 'fabric.jar', {
			'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'menu', name: 'Menu', environment: 'client' }),
			'com/example/menu/Api.class': 'x',
			'META-INF/jars/lib.jar': zipBuffer({ 'org/lib/Inner.class': 'x' })
		});
		await writeJar(dir, 'quilt.jar', {
			'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'qmod', metadata: { name: 'Q Mod' } }, minecraft: { environment: 'client' } })
		});
		await writeJar(dir, 'neo.jar', { 'META-INF/neoforge.mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="neomod"\ndisplayName="Neo Mod"\n' });
		await writeJar(dir, 'legacy.jar.disabled', { 'mcmod.info': mcmodInfo('oldmod', 'Old Mod'), 'mixins.oldmod.json': '{}' });

		const byFile = Object.fromEntries((await indexMods(dir)).map((j) => [j.fileName, j]));
		expect(byFile['fabric.jar']).toMatchObject({ ids: ['menu'], names: ['Menu'], clientOnly: true, enabled: true });
		expect([...byFile['fabric.jar'].classes].sort()).toEqual(['com.example.menu.Api', 'org.lib.Inner']);
		expect(byFile['quilt.jar']).toMatchObject({ ids: ['qmod'], names: ['Q Mod'], clientOnly: true });
		expect(byFile['neo.jar']).toMatchObject({ ids: ['neomod'], names: ['Neo Mod'], clientOnly: false });
		expect(byFile['legacy.jar.disabled']).toMatchObject({ ids: ['oldmod'], enabled: false, mixinConfigs: ['mixins.oldmod.json'] });
	});

	it('takes mod ids from [[mods]] blocks only, not from dependency blocks', async () => {
		// Every dependency block has a modId too; reading those made a jar
		// "minecraft" or "forge" as far as crash attribution was concerned.
		const dir = await tempDir();
		await writeJar(dir, 'checker.jar', {
			'META-INF/mods.toml':
				'[[mods]]\nmodId="checker"\ndisplayName="Checker"\n[[dependencies."checker"]]\nmodId="minecraft"\nmandatory=true\n'
		});
		const [jar] = await indexMods(dir);
		expect(jar).toMatchObject({ ids: ['checker'], names: ['Checker'] });
	});
});

describe('the same mod installed twice', () => {
	it('finds enabled jars with one mod id by what the jars declare, not by name', async () => {
		const dir = await tempDir('dupes-');
		const fabric = (id: string, name: string) => JSON.stringify({ schemaVersion: 1, id, name, version: '1' });
		// Once from Modrinth, once from CurseForge, under other file names.
		await writeJar(dir, 'sodium-fabric-0.6.0+mc1.21.1.jar', { 'fabric.mod.json': fabric('sodium', 'Sodium') });
		await writeJar(dir, 'sodium-mc1.21.1-0.6.0.jar', { 'fabric.mod.json': fabric('sodium', 'Sodium') });
		// A disabled copy does not count; the loader skips it.
		await writeJar(dir, 'lithium-a.jar', { 'fabric.mod.json': fabric('lithium', 'Lithium') });
		await writeJar(dir, 'lithium-b.jar.disabled', { 'fabric.mod.json': fabric('lithium', 'Lithium') });
		// Template ids that unrelated 1.12 mods keep (Born in a Barn says "examplemod").
		await writeJar(dir, 'borninabarn.jar', { 'mcmod.info': mcmodInfo('examplemod', 'Born in a Barn') });
		await writeJar(dir, 'other.jar', { 'mcmod.info': mcmodInfo('examplemod', 'Something Else') });
		// A Forge jar whose dependency blocks name the same mod is not a copy of it.
		await writeJar(dir, 'addon.jar', {
			'META-INF/mods.toml': '[[mods]]\nmodId="addon"\n[[dependencies.addon]]\nmodId="sodium"\nmandatory=true\n'
		});
		expect(duplicateMods(await indexMods(dir))).toEqual([
			{ id: 'sodium', name: 'Sodium', files: ['sodium-fabric-0.6.0+mc1.21.1.jar', 'sodium-mc1.21.1-0.6.0.jar'] }
		]);
	});
});

describe('what needs a mod', () => {
	const fabric = (id: string, name: string, extra: object = {}) => JSON.stringify({ schemaVersion: 1, id, name, version: '1', ...extra });
	const forge = (id: string, deps: string) => `[[mods]]\nmodId="${id}"\ndisplayName="${id}"\n${deps}`;

	it('names the enabled mods a jar is the only one to provide for', async () => {
		const dir = await tempDir('needs-');
		await writeJar(dir, 'cloth.jar', { 'fabric.mod.json': fabric('cloth-config', 'Cloth Config') });
		await writeJar(dir, 'zoom.jar', { 'fabric.mod.json': fabric('zoom', 'Zoom', { depends: { 'cloth-config': '*', minecraft: '1.21.1' } }) });
		await writeJar(dir, 'menu.jar', { 'fabric.mod.json': fabric('menu', 'Menu', { depends: { 'cloth-config': '*' } }) });
		// Disabled, client-only and merely suggesting it: none of these stop a start without it.
		await writeJar(dir, 'off.jar.disabled', { 'fabric.mod.json': fabric('off', 'Off', { depends: { 'cloth-config': '*' } }) });
		await writeJar(dir, 'hud.jar', { 'fabric.mod.json': fabric('hud', 'Hud', { environment: 'client', depends: { 'cloth-config': '*' } }) });
		await writeJar(dir, 'extra.jar', { 'fabric.mod.json': fabric('extra', 'Extra', { recommends: { zoom: '*' } }) });
		expect(requiredBy(await indexMods(dir))).toEqual({ 'cloth.jar': ['Menu', 'Zoom'] });
	});

	it('leaves out optional and client-side Forge dependencies', async () => {
		const dir = await tempDir('needs-');
		await writeJar(dir, 'lib.jar', { 'META-INF/mods.toml': forge('lib', '') });
		await writeJar(dir, 'a.jar', { 'META-INF/mods.toml': forge('a', '[[dependencies.a]]\nmodId="lib"\nmandatory=false\n') });
		await writeJar(dir, 'b.jar', { 'META-INF/neoforge.mods.toml': forge('b', '[[dependencies.b]]\nmodId="lib"\ntype="optional"\n') });
		await writeJar(dir, 'c.jar', { 'META-INF/mods.toml': forge('c', '[[dependencies.c]]\nmodId="lib"\nmandatory=true\nside="CLIENT"\n') });
		expect(requiredBy(await indexMods(dir))).toEqual({});
		await writeJar(dir, 'd.jar', { 'META-INF/neoforge.mods.toml': forge('d', '[[dependencies.d]]\nmodId="lib"\ntype="required"\nside="BOTH"\n') });
		expect(requiredBy(await indexMods(dir))).toEqual({ 'lib.jar': ['d'] });
	});

	it('counts what another enabled jar provides or nests, and shows a disabled one the mods missing it', async () => {
		const dir = await tempDir('needs-');
		await writeJar(dir, 'cloth.jar', { 'fabric.mod.json': fabric('cloth-config', 'Cloth Config') });
		// This one carries its own copy, so the separate jar is not the only one.
		await writeJar(dir, 'bundle.jar', {
			'fabric.mod.json': fabric('bundle', 'Bundle', { depends: { 'cloth-config': '*' } }),
			'META-INF/jars/cloth.jar': zipBuffer({ 'fabric.mod.json': fabric('cloth-config', 'Cloth Config') })
		});
		await writeJar(dir, 'api.jar.disabled', { 'fabric.mod.json': fabric('fabric-api', 'Fabric API', { provides: ['fabric'] }) });
		await writeJar(dir, 'old.jar', { 'fabric.mod.json': fabric('old', 'Old', { depends: { fabric: '*', 'cloth-config': '*' } }) });
		expect(requiredBy(await indexMods(dir))).toEqual({ 'api.jar.disabled': ['Old'] });
	});
});
