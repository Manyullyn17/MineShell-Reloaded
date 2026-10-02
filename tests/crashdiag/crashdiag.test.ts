import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseLog, indexMods, type ModJar } from '$lib/server/crashdiag';
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
});
