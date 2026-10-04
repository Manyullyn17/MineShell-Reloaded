import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spark answers after RCON has returned, so the fake RCON answers nothing for
 * Spark commands and instead runs what Spark would do later: a console line
 * and, when the profile is done, an entry in activity.json.
 */
const rcon = vi.hoisted(() => ({
	commands: [] as string[],
	answers: {} as Record<string, string>,
	after: {} as Record<string, () => Promise<void> | void>
}));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		for (const c of commands) {
			const later = rcon.after[c];
			if (later) setTimeout(() => void later(), 20);
		}
		return commands.map((c) => rcon.answers[c] ?? '');
	})
}));

const { activeProfile, cancelProfile, hasSpark, sparkUploads, startProfile, stopProfile, SparkError } = await import(
	'#lib/server/spark.js'
);
const { bus } = await import('#lib/server/events.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance, waitForTask } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');
const { writeJar } = await import('../helpers/fs');

const FAST = { pollMs: 10, confirmMs: 300, uploadGraceMs: 1000, stateCheckMs: 10_000 };
const URL = 'https://spark.lucko.me/Xy12AbCd';

async function server() {
	return createInstance({
		modloader: 'fabric',
		minecraftVersion: '1.20.1',
		rconPort: 25598,
		rconPasswordEnc: encryptSecret('pw')
	});
}

type Server = Awaited<ReturnType<typeof server>>;

function sparkSays(instance: Server, line: string) {
	bus.publish('console:line', { instanceId: instance.id, line: `[12:00:00] [spark-worker-pool-1-thread-1/INFO]: ${line}`, ts: Date.now() });
}

async function sparkRecords(instance: Server, kind: 'url' | 'file', value: string, type = 'Profiler') {
	const file = path.join(instance.path, 'config', 'spark', 'activity.json');
	await fs.mkdir(path.dirname(file), { recursive: true });
	const old = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]'));
	const entry = { user: { type: 'other', name: 'Rcon' }, time: Date.now(), type, data: { type: kind, value } };
	await fs.writeFile(file, JSON.stringify([entry, ...old]));
}

describe('Spark profiles', () => {
	beforeEach(() => {
		rcon.commands = [];
		rcon.answers = {};
		rcon.after = {};
		invalidateUnitState();
		// journalctl -f for the console tail prints nothing; systemd says running.
		fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\n' } : {}));
	});

	it('starts a timed profile and finishes with the uploaded link', async () => {
		const instance = await server();
		rcon.after['spark profiler --timeout 30'] = async () => {
			sparkSays(instance, '[⚡] Profiler is now running! (async)');
			await sparkRecords(instance, 'url', URL);
		};
		const taskId = startProfile(instance, 30, FAST);
		expect(activeProfile(instance.id)?.taskId).toBe(taskId);

		const task = await waitForTask(taskId);
		expect(task.state).toBe('done');
		expect(task.log).toContain(`Uploaded: ${URL}`);
		expect(activeProfile(instance.id)).toBeNull();
		expect((await sparkUploads(instance.path))[0].url).toBe(URL);
	});

	it('ignores uploads from before it started', async () => {
		const instance = await server();
		await sparkRecords(instance, 'url', 'https://spark.lucko.me/older');
		await new Promise((r) => setTimeout(r, 5));
		rcon.after['spark profiler --timeout 30'] = async () => {
			sparkSays(instance, '[⚡] Profiler is now running!');
			await new Promise((r) => setTimeout(r, 50));
			await sparkRecords(instance, 'url', URL);
		};
		const task = await waitForTask(startProfile(instance, 30, FAST));
		expect(task.log).toContain(`Uploaded: ${URL}`);
	});

	it('reports a profile Spark saved to disk instead of uploading', async () => {
		const instance = await server();
		rcon.after['spark profiler --timeout 60'] = async () => {
			sparkSays(instance, '[⚡] Profiler is now running!');
			await sparkRecords(instance, 'file', '/srv/config/spark/tmp/p.sparkprofile');
		};
		const task = await waitForTask(startProfile(instance, 60, FAST));
		expect(task.state).toBe('done');
		expect(task.log.join('\n')).toContain('saved it to /srv/config/spark/tmp/p.sparkprofile');
	});

	it('fails at once when the server does not know the command', async () => {
		const instance = await server();
		rcon.answers['spark profiler --timeout 30'] = 'Unknown or incomplete command, see below for error';
		const task = await waitForTask(startProfile(instance, 30, FAST));
		expect(task.state).toBe('failed');
		expect(task.error).toContain('did not take the command');
	});

	it('fails when Spark never says it started (one already running, or an old Spark)', async () => {
		const instance = await server();
		const task = await waitForTask(startProfile(instance, 30, FAST));
		expect(task.state).toBe('failed');
		expect(task.error).toContain('did not report starting a profiler');
	});

	it('reads the start from Spark 1.5 (Forge 1.12.2) too, but not its "already running"', async () => {
		const instance = await server();
		rcon.after['spark profiler --timeout 30'] = async () => {
			sparkSays(instance, '[⚡] Initializing a new profiler, please wait...');
			await sparkRecords(instance, 'url', URL);
		};
		expect((await waitForTask(startProfile(instance, 30, FAST))).state).toBe('done');

		rcon.after['spark profiler --timeout 30'] = () => sparkSays(instance, '[⚡] An active profiler is already running.');
		const task = await waitForTask(startProfile(instance, 30, FAST));
		expect(task.state).toBe('failed');
		expect(task.error).toContain('did not report starting a profiler');
	});

	it('stops early: Spark uploads what it has', async () => {
		const instance = await server();
		rcon.after['spark profiler --timeout 600'] = () => sparkSays(instance, '[⚡] Profiler is now running!');
		rcon.after['spark profiler --stop'] = () => sparkRecords(instance, 'url', URL);
		const taskId = startProfile(instance, 600, FAST);
		await new Promise((r) => setTimeout(r, 60));
		await stopProfile(instance);
		const task = await waitForTask(taskId);
		expect(task.state).toBe('done');
		expect(rcon.commands).toEqual(['spark profiler --timeout 600', 'spark profiler --stop']);
	});

	it('cancels: Spark is told to discard it', async () => {
		const instance = await server();
		rcon.after['spark profiler --timeout 600'] = () => sparkSays(instance, '[⚡] Profiler is now running!');
		const taskId = startProfile(instance, 600, FAST);
		await new Promise((r) => setTimeout(r, 60));
		cancelProfile(instance);
		const task = await waitForTask(taskId);
		expect(task.state).toBe('cancelled');
		expect(rcon.commands).toContain('spark profiler --cancel');
		expect(activeProfile(instance.id)).toBeNull();
	});

	it('refuses a second profile and durations Spark would reject', async () => {
		const instance = await server();
		rcon.after['spark profiler --timeout 600'] = () => sparkSays(instance, '[⚡] Profiler is now running!');
		const other = await server();
		const taskId = startProfile(instance, 600, FAST);
		expect(() => startProfile(instance, 600, FAST)).toThrow(SparkError);
		expect(() => startProfile(other, 10, FAST)).toThrow(SparkError);
		cancelProfile(instance);
		await waitForTask(taskId);
	});

	it('fails when the server stops mid-profile', async () => {
		const instance = await server();
		rcon.after['spark profiler --timeout 30'] = () => sparkSays(instance, '[⚡] Profiler is now running!');
		const taskId = startProfile(instance, 30, { ...FAST, stateCheckMs: 20 });
		await new Promise((r) => setTimeout(r, 40));
		invalidateUnitState();
		fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=inactive\nSubState=dead\n' } : {}));
		const task = await waitForTask(taskId);
		expect(task.state).toBe('failed');
		expect(task.error).toContain('stopped before the profile finished');
	});

	it('knows whether Spark is installed, by mod id', async () => {
		const instance = await server();
		expect(await hasSpark(instance.path)).toBe(false);
		await writeJar(path.join(instance.path, 'mods'), 'spark-1.10.53-fabric.jar', {
			'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'spark', version: '1.10.53' })
		});
		expect(await hasSpark(instance.path)).toBe(true);
		await fs.rename(
			path.join(instance.path, 'mods', 'spark-1.10.53-fabric.jar'),
			path.join(instance.path, 'mods', 'spark-1.10.53-fabric.jar.disabled')
		);
		expect(await hasSpark(instance.path)).toBe(false);
	});
});
