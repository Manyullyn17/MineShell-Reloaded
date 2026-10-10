import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerInstance } from '#lib/server/db/schema.js';

const { bisectState, bisectTiming, BISECT_WORLD, startBisect } = await import('#lib/server/bisect.js');
const { beginOperation } = await import('#lib/server/operations.js');
const { readProperties, patchProperties } = await import('#lib/server/properties.js');
const { start } = await import('#lib/server/instances.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance, reload, waitForTask } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');
const { writeJar } = await import('../helpers/fs');
const { restartMineShell } = await import('../helpers/crash');
const { testPorts } = await import('../helpers/ports');

bisectTiming.pollMs = 5;
bisectTiming.textGraceMs = 20;

/**
 * A fake server: a start "crashes" (exits before Done) when `crashWhen` says so
 * for the jars enabled at that moment, and starts fine otherwise. Every start
 * is recorded with what was enabled.
 */
let crashWhen: (enabled: Set<string>) => boolean;
let startsWith: Set<string>[] = [];
let onStart: (dir: string) => Promise<void> = async () => {};

async function fakeServer(instance: ServerInstance) {
	let n = 0;
	let active = false;
	let failed = false;
	let lines = '';
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemctl' && args.includes('start')) {
			// The mods folder as it is at this start.
			const enabled = new Set<string>(readdirSync(path.join(instance.path, 'mods')).filter((f) => f.endsWith('.jar')));
			startsWith.push(enabled);
			void onStart(instance.path);
			n++;
			const crash = crashWhen(enabled);
			active = !crash;
			failed = crash;
			lines = crash ? 'Started x.service\n[main/ERROR]: something broke\n' : 'Started x.service\n[12:00:00] [Server thread/INFO]: Done (1.0s)!\n';
			invalidateUnitState();
			return {};
		}
		if (cmd === 'systemctl' && args.includes('stop')) {
			active = false;
			invalidateUnitState();
			return {};
		}
		if (cmd === 'systemctl' && args.includes('show')) {
			return { stdout: `ActiveState=${active ? 'active' : failed ? 'failed' : 'inactive'}\nSubState=dead\nResult=success\n` };
		}
		if (cmd === 'journalctl' && args.includes('json')) {
			return { stdout: JSON.stringify({ __CURSOR: `c${n}`, _SYSTEMD_INVOCATION_ID: String(n).padStart(32, 'a') }) + '\n' };
		}
		if (cmd === 'journalctl') return { stdout: lines };
		return {};
	});
}

const mod = (id: string, depends: string[] = []) => ({ 'fabric.mod.json': JSON.stringify({ id, depends: Object.fromEntries(depends.map((d) => [d, '*'])) }) });

async function server(jars: Record<string, ReturnType<typeof mod>>, disabled: string[] = []) {
	const instance = await createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.20.1', eulaAccepted: true, ...testPorts(), autoRestartOnCrash: true, wantedRunning: true },
		{
			'eula.txt': 'eula=true\n',
			'server.properties': 'level-name=world\n',
			'world/level.dat': 'the real world',
			'config/a.cfg': 'original'
		}
	);
	for (const [file, files] of Object.entries(jars)) await writeJar(path.join(instance.path, 'mods'), file, files);
	for (const file of disabled) await fs.rename(path.join(instance.path, 'mods', file), path.join(instance.path, 'mods', `${file}.disabled`));
	await fakeServer(instance);
	return instance;
}

const enabledNow = async (dir: string) => (await fs.readdir(path.join(dir, 'mods'))).filter((f) => f.endsWith('.jar')).sort();

beforeEach(() => {
	startsWith = [];
	onStart = async () => {};
});

describe('mod bisect assistant', () => {
	it('finds the one mod a crash comes from, and puts everything back', async () => {
		const jars = Object.fromEntries('abcdefgh'.split('').map((c) => [`${c}.jar`, mod(c)]));
		const s = await server(jars, ['h.jar']);
		crashWhen = (on) => on.has('e.jar');
		// Mods rewrite configs when others are missing: the original comes back.
		onStart = async (dir) => fs.writeFile(path.join(dir, 'config/a.cfg'), 'rewritten');
		const task = await waitForTask(await startBisect(s, { keepOn: [], logText: null }), 10_000);
		expect(task.error).toBeNull();
		const state = bisectState(s.id)!;
		expect(state).toMatchObject({ status: 'found', culprits: ['e.jar'], suspects: 7 });
		expect(state.tests.length).toBeLessThanOrEqual(state.estimate + 1);

		expect(await enabledNow(s.path)).toEqual(['a.jar', 'b.jar', 'c.jar', 'd.jar', 'e.jar', 'f.jar', 'g.jar']);
		expect((await readProperties(s.path)).values['level-name']).toBe('world');
		expect(await fs.readFile(path.join(s.path, 'world/level.dat'), 'utf8')).toBe('the real world');
		expect(await fs.readFile(path.join(s.path, 'config/a.cfg'), 'utf8')).toBe('original');
		await expect(fs.access(path.join(s.path, BISECT_WORLD))).rejects.toThrow();
		expect(reload(s.id)).toMatchObject({ autoRestartOnCrash: true, wantedRunning: true });
	});

	it('finds both mods of a crash that needs the two together', async () => {
		const jars = Object.fromEntries('abcdefgh'.split('').map((c) => [`${c}.jar`, mod(c)]));
		const s = await server(jars);
		crashWhen = (on) => on.has('b.jar') && on.has('g.jar');
		await waitForTask(await startBisect(s, { keepOn: [], logText: null }), 10_000);
		expect(bisectState(s.id)).toMatchObject({ status: 'found', culprits: ['b.jar', 'g.jar'] });
	});

	it('keeps kept-on mods on and turns a mod on with what it depends on', async () => {
		const s = await server({ 'lib.jar': mod('lib'), 'user.jar': mod('user', ['lib']), 'x.jar': mod('x'), 'y.jar': mod('y'), 'keep.jar': mod('keep') });
		crashWhen = (on) => on.has('user.jar');
		await waitForTask(await startBisect(s, { keepOn: ['keep.jar'], logText: null }), 10_000);
		expect(bisectState(s.id)).toMatchObject({ status: 'found', culprits: ['user.jar'] });
		expect(startsWith.every((on) => on.has('keep.jar'))).toBe(true);
		expect(startsWith.every((on) => !on.has('user.jar') || on.has('lib.jar'))).toBe(true);
	});

	it('stops when the problem does not happen with every mod on', async () => {
		const s = await server({ 'a.jar': mod('a'), 'b.jar': mod('b') });
		crashWhen = () => false;
		await waitForTask(await startBisect(s, { keepOn: [], logText: null }), 10_000);
		expect(bisectState(s.id)?.status).toBe('not-reproduced');
		expect(startsWith).toHaveLength(1);
	});

	it('refuses ordinary starts while it searches', async () => {
		const s = await server({ 'a.jar': mod('a') });
		beginOperation(s.id, { kind: 'bisect', levelName: 'world', enabledBefore: ['a.jar'], autoRestartBefore: true, wantedRunningBefore: false });
		expect((await start(reload(s.id))).message).toMatch(/search for the mod behind a crash/);
	});

	it('is put back by recovery when MineShell dies in the middle', async () => {
		const s = await server({ 'a.jar': mod('a'), 'b.jar': mod('b') });
		beginOperation(s.id, { kind: 'bisect', levelName: 'world', enabledBefore: ['a.jar', 'b.jar'], autoRestartBefore: true, wantedRunningBefore: true });
		// Mid-search: b off, the throwaway world in use, crash restarts off.
		await fs.rename(path.join(s.path, 'mods/b.jar'), path.join(s.path, 'mods/b.jar.disabled'));
		await patchProperties(s.path, { 'level-name': BISECT_WORLD });
		await fs.mkdir(path.join(s.path, BISECT_WORLD));
		await restartMineShell();
		expect(await enabledNow(s.path)).toEqual(['a.jar', 'b.jar']);
		expect((await readProperties(s.path)).values['level-name']).toBe('world');
		await expect(fs.access(path.join(s.path, BISECT_WORLD))).rejects.toThrow();
	});
});
