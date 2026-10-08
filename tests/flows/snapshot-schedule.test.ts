import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ commands: [] as string[], failOn: null as string | null, onStop: () => {} }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		for (const c of commands) {
			if (rcon.failOn && c === rcon.failOn) throw new Error('connection refused');
			rcon.commands.push(c);
			if (c === 'stop') rcon.onStop();
		}
		return commands.map(() => '');
	})
}));

const sched = await import('#lib/server/snapshotschedule.js');
const { listSnapshots } = await import('#lib/server/snapshots.js');
const { beginOperation, listOperations } = await import('#lib/server/operations.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance, reload, waitForTask } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');
const { restartMineShell } = await import('../helpers/crash');

sched.scheduleTiming.pollMs = 5;
sched.scheduleTiming.quietMs = 50;
sched.scheduleTiming.quietMaxMs = 300;

let active = true;
function fakeUnit() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd !== 'systemctl') return {};
		if (args.includes('show')) return { stdout: `ActiveState=${active ? 'active' : 'inactive'}\nSubState=${active ? 'running' : 'dead'}\n` };
		if (args.includes('start')) active = true;
		if (args.includes('stop')) active = false;
		invalidateUnitState();
		return {};
	});
}

async function server() {
	// Ports nothing on the machine uses: a start checks them.
	const port = 47900 + (process.pid % 300) * 13 + Math.floor(Math.random() * 10);
	const s = await createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1', serverPort: port, rconPort: port + 1, rconPasswordEnc: encryptSecret('pw'), eulaAccepted: true },
		{ 'eula.txt': 'eula=true\n', 'server.properties': 'level-name=world\n', 'world/level.dat': 'level', 'world/region/r.0.0.mca': 'chunks' }
	);
	// Written long ago: the world is quiet at once.
	const old = new Date(Date.now() - 60_000);
	for (const f of ['world/level.dat', 'world/region/r.0.0.mca']) await fs.utimes(path.join(s.path, f), old, old);
	return s;
}

beforeEach(() => {
	rcon.commands = [];
	rcon.failOn = null;
	rcon.onStop = () => {
		active = false;
		invalidateUnitState();
	};
	active = true;
	fakeUnit();
});

describe('scheduled snapshots', () => {
	it('works out the next slot, daily or every few hours', () => {
		const from = new Date(2026, 9, 8, 5, 0).getTime();
		const daily = sched.validSchedule({ every: 'daily', dailyTime: '04:00' });
		expect(new Date(sched.nextSnapshotAt(daily, from)!).toString()).toBe(new Date(2026, 9, 9, 4, 0).toString());
		expect(sched.nextSnapshotAt(sched.validSchedule({ every: 'interval', intervalHours: 12 }), from)).toBe(from + 12 * 3_600_000);
		expect(sched.validSchedule({ every: 'weekly', dailyTime: '25:00', intervalHours: 0, warnMinutes: 99 })).toEqual(sched.DEFAULT_SCHEDULE);
	});

	it('copies a running world with saving paused, and turns it back on', async () => {
		const s = await server();
		const task = await waitForTask(sched.scheduledSnapshot(s, 'live'));
		expect(task.error).toBeNull();
		expect(rcon.commands).toEqual(['save-off', 'save-all flush', 'save-on']);
		const [snapshot] = await listSnapshots(s.path);
		expect(snapshot).toMatchObject({ reason: 'scheduled', label: 'Scheduled, while running', worlds: ['world'] });
		expect(listOperations()).toEqual([]);
		expect(active).toBe(true);
	});

	it('turns saving back on when the copy fails', async () => {
		const s = await server();
		await fs.chmod(path.join(s.path, 'world/region'), 0o000);
		try {
			const task = await waitForTask(sched.scheduledSnapshot(s, 'live'));
			expect(task.error).toBeTruthy();
		} finally {
			await fs.chmod(path.join(s.path, 'world/region'), 0o755);
		}
		expect(rcon.commands.at(-1)).toBe('save-on');
		expect(await listSnapshots(s.path)).toEqual([]);
	});

	it('takes nothing when saving cannot be paused', async () => {
		const s = await server();
		rcon.failOn = 'save-off';
		const task = await waitForTask(sched.scheduledSnapshot(s, 'live'));
		expect(task.error).toMatch(/did not answer over RCON/);
		expect(await listSnapshots(s.path)).toEqual([]);
	});

	it('stops the server for the copy and starts it again', async () => {
		const s = await server();
		const task = await waitForTask(sched.scheduledSnapshot(s, 'stop'), 8000);
		expect(task.error).toBeNull();
		expect(rcon.commands).toContain('stop');
		expect(active).toBe(true);
		expect(spawnCalls.some((c) => c.cmd === 'systemctl' && c.args.includes('start'))).toBe(true);
		expect((await listSnapshots(s.path))[0]).toMatchObject({ label: 'Scheduled, server stopped for it' });
		expect(reload(s.id).status).toBe('ready');
	});

	it('warns before a stop, then fires once the time comes, moving to the next slot', async () => {
		const s = await server();
		sched.saveSnapshotSchedule(s.id, sched.validSchedule({ every: 'interval', intervalHours: 6, whileRunning: 'stop', warnMinutes: 5 }));
		const at = sched.scheduledSnapshotAt(s.id)!;
		expect(await sched.evaluateSnapshotSchedule(s, at - 4 * 60_000)).toBeNull();
		expect(rcon.commands).toEqual(['say The server stops for a world backup in 5 minutes; back right after.']);
		await sched.evaluateSnapshotSchedule(s, at - 3 * 60_000);
		expect(rcon.commands).toHaveLength(1);
		const taskId = await sched.evaluateSnapshotSchedule(s, at + 1000);
		expect(taskId).toBeTruthy();
		await waitForTask(taskId!, 8000);
		expect(sched.scheduledSnapshotAt(s.id)).toBe(at + 1000 + 6 * 3_600_000);
	});

	it('copies a stopped server as it is', async () => {
		const s = await server();
		active = false;
		fakeUnit();
		sched.saveSnapshotSchedule(s.id, sched.validSchedule({ every: 'daily', dailyTime: '04:00' }));
		const taskId = await sched.evaluateSnapshotSchedule(s, sched.scheduledSnapshotAt(s.id)! + 1);
		await waitForTask(taskId!);
		expect(rcon.commands).toEqual([]);
		expect((await listSnapshots(s.path))[0]).toMatchObject({ label: 'Scheduled, server stopped' });
		expect(active).toBe(false);
	});

	it('is put right by recovery: saving back on, or the server started again', async () => {
		const live = await server();
		beginOperation(live.id, { kind: 'scheduled-snapshot', mode: 'live', restart: false });
		await restartMineShell();
		expect(rcon.commands).toContain('save-on');

		const stopped = await server();
		active = false;
		fakeUnit();
		beginOperation(stopped.id, { kind: 'scheduled-snapshot', mode: 'stop', restart: true });
		await restartMineShell();
		expect(active).toBe(true);
		expect(listOperations()).toEqual([]);
	});
});
