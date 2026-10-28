import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseLog, duplicateMods, indexMods, type ModJar } from '#lib/server/crashdiag.js';
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

describe('chat in the log', () => {
	const sodium: ModJar = { fileName: 'sodium.jar', enabled: true, ids: ['sodium'], names: ['Sodium'], version: '0.5.8', authors: [], clientOnly: false, requires: [], classes: new Set(), mixinConfigs: [] };
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
