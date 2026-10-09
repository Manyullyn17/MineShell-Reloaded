import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ commands: [] as string[], failOn: null as string | null, onStop: () => {}, replies: {} as Record<string, string> }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		for (const c of commands) {
			if (rcon.failOn && c === rcon.failOn) throw new Error('connection refused');
			rcon.commands.push(c);
			if (c === 'stop') rcon.onStop();
		}
		return commands.map((c) => rcon.replies[c] ?? '');
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
const { evaluateRestart } = await import('#lib/server/scheduler.js');
const { db } = await import('#lib/server/db/index.js');
const { playerSessions, serverInstances } = await import('#lib/server/db/schema.js');
const { eq } = await import('drizzle-orm');

sched.scheduleTiming.pollMs = 5;
sched.scheduleTiming.quietMs = 50;
sched.scheduleTiming.quietMaxMs = 300;

let active = true;
/** Whether the run has logged "Done (": the journal the fake answers with. */
let started = true;
let enteredAt = 1000;
function fakeUnit() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'journalctl') return { stdout: started ? '[12:00:00] [Server thread/INFO]: Done (3.1s)! For help, type "help"\n' : '' };
		if (cmd !== 'systemctl') return {};
		if (args.includes('show'))
			return { stdout: `ActiveState=${active ? 'active' : 'inactive'}\nSubState=${active ? 'running' : 'dead'}\nActiveEnterTimestampMonotonic=${enteredAt}\n` };
		if (args.includes('restart')) enteredAt += 1000;
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
	rcon.replies = {};
	started = true;
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
		expect(new Date(sched.nextSnapshotAt(sched.validSchedule({ every: 'interval', intervalHours: 12 }), from)!).toString()).toBe(
			new Date(2026, 9, 8, 12, 0).toString()
		);
		expect(sched.validSchedule({ every: 'weekly', dailyTime: '25:00', intervalHours: 0, warnMinutes: 99 })).toEqual(sched.DEFAULT_SCHEDULE);
	});

	it('puts "every N hours" on the clock', () => {
		const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
		expect(sched.clockSlot(1, at(8, 5, 20))).toBe(at(8, 6));
		expect(sched.clockSlot(1, at(8, 6))).toBe(at(8, 7));
		// Every 5: 0, 5, 10, 15, 20, then midnight again.
		expect(sched.clockSlot(5, at(8, 21))).toBe(at(9, 0));
		expect(sched.clockSlot(6, at(8, 13, 59))).toBe(at(8, 18));
		// Whole days fall on midnight, the same days whenever it is asked.
		const twoDays = sched.clockSlot(48, at(8, 10));
		expect(new Date(twoDays).getHours()).toBe(0);
		expect(sched.clockSlot(48, at(8, 23))).toBe(twoDays);
		expect(sched.clockSlot(30, at(8, 10))).toBe(at(8, 10) + 30 * 3_600_000);
		expect(sched.describeSnapshotSchedule(sched.validSchedule({ every: 'interval', intervalHours: 1 }))).toBe('Every hour, on the hour, while running');
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
		sched.saveSnapshotSchedule(s.id, sched.validSchedule({ every: 'interval', intervalHours: 6, whileRunning: 'stop', warnMinutes: 5, skipIdle: false }));
		const at = sched.scheduledSnapshotAt(s.id)!;
		expect(await sched.evaluateSnapshotSchedule(s, at - 4 * 60_000)).toBeNull();
		expect(rcon.commands).toEqual(['say The server stops for a world backup in 5 minutes; back right after.']);
		await sched.evaluateSnapshotSchedule(s, at - 3 * 60_000);
		expect(rcon.commands).toHaveLength(1);
		const taskId = await sched.evaluateSnapshotSchedule(s, at + 1000);
		expect(taskId).toBeTruthy();
		await waitForTask(taskId!, 8000);
		expect(sched.scheduledSnapshotAt(s.id)).toBe(sched.clockSlot(6, at + 1000));
	});

	it('copies a stopped server as it is', async () => {
		const s = await server();
		active = false;
		fakeUnit();
		sched.saveSnapshotSchedule(s.id, sched.validSchedule({ every: 'daily', dailyTime: '04:00', skipIdle: false }));
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

	it('skips a slot nobody played in since the last snapshot, unless someone was on or is on now', async () => {
		const s = await server();
		sched.saveSnapshotSchedule(s.id, sched.validSchedule({ every: 'interval', intervalHours: 1 }));
		// The first one is always taken: there is no snapshot to compare with.
		const first = await sched.evaluateSnapshotSchedule(s, sched.scheduledSnapshotAt(s.id)! + 1);
		await waitForTask(first!);
		expect(await listSnapshots(s.path)).toHaveLength(1);

		// Nobody since: skipped, the next slot set.
		const due = sched.scheduledSnapshotAt(s.id)! + 1;
		expect(await sched.evaluateSnapshotSchedule(s, due)).toBeNull();
		expect(await listSnapshots(s.path)).toHaveLength(1);
		expect(sched.scheduledSnapshotAt(s.id)).toBe(sched.clockSlot(1, due));

		// Someone online right now (RCON's list) counts.
		rcon.replies.list = 'There are 1 of a max of 20 players online: Steve';
		await waitForTask((await sched.evaluateSnapshotSchedule(s, sched.scheduledSnapshotAt(s.id)! + 1))!);
		expect(await listSnapshots(s.path)).toHaveLength(2);

		// So does a session the log recorded since the last snapshot, ended or not.
		rcon.replies = {};
		db.insert(playerSessions).values({ instanceId: s.id, player: 'Alex', joinedAt: Date.now() - 1000, leftAt: Date.now() + 1000 }).run();
		await waitForTask((await sched.evaluateSnapshotSchedule(s, sched.scheduledSnapshotAt(s.id)! + 1))!);
		expect(await listSnapshots(s.path)).toHaveLength(3);
	});

	it('waits while the server has not finished starting or a restart is due, and lets the slot go after 30 minutes', async () => {
		const s = await server();
		sched.saveSnapshotSchedule(s.id, sched.validSchedule({ every: 'interval', intervalHours: 1, skipIdle: false }));
		const at = sched.scheduledSnapshotAt(s.id)!;

		started = false;
		fakeUnit();
		expect(await sched.evaluateSnapshotSchedule(s, at + 1)).toBeNull();
		expect(sched.scheduledSnapshotAt(s.id)).toBe(at);
		started = true;
		fakeUnit();

		// A scheduled restart within its warning time: wait for it too.
		db.update(serverInstances).set({ restartSchedule: 'daily', restartDailyTime: '05:00', restartWarnMinutes: 5, restartNextAt: at + 2 * 60_000 }).where(eq(serverInstances.id, s.id)).run();
		expect(await sched.evaluateSnapshotSchedule(reload(s.id), at + 2)).toBeNull();
		expect(sched.scheduledSnapshotAt(s.id)).toBe(at);

		// Still not ready half an hour on: that slot is let go.
		expect(await sched.evaluateSnapshotSchedule(reload(s.id), at + 31 * 60_000)).toBeNull();
		expect(sched.scheduledSnapshotAt(s.id)).toBe(sched.clockSlot(1, at + 31 * 60_000));
		expect(await listSnapshots(s.path)).toEqual([]);

		// Ready (restart moved away): taken.
		db.update(serverInstances).set({ restartNextAt: Date.now() + 10 * 3_600_000 }).where(eq(serverInstances.id, s.id)).run();
		const next = sched.scheduledSnapshotAt(s.id)!;
		await waitForTask((await sched.evaluateSnapshotSchedule(reload(s.id), next + 1))!);
		expect(await listSnapshots(s.path)).toHaveLength(1);
	});

	it('holds a scheduled restart while a snapshot is under way', async () => {
		const s = await server();
		db.update(serverInstances).set({ restartSchedule: 'daily', restartDailyTime: '05:00', restartWarnMinutes: 0, restartNextAt: Date.now() - 1000 }).where(eq(serverInstances.id, s.id)).run();
		beginOperation(s.id, { kind: 'scheduled-snapshot', mode: 'live', restart: false });
		spawnCalls.length = 0;
		await evaluateRestart(reload(s.id));
		expect(spawnCalls.some((c) => c.args.includes('restart'))).toBe(false);
		expect(reload(s.id).restartNextAt).toBeLessThan(Date.now());

		const { endOperation } = await import('#lib/server/operations.js');
		endOperation(s.id);
		await evaluateRestart(reload(s.id));
		expect(spawnCalls.some((c) => c.args.includes('restart'))).toBe(true);
	});

	it('does not claim saving stayed off when the server restarted during the copy', async () => {
		const s = await server();
		rcon.failOn = 'save-on';
		const task = sched.scheduledSnapshot(s, 'live');
		enteredAt += 5000;
		fakeUnit();
		await waitForTask(task);
		expect(reload(s.id).statusMessage).toBeNull();

		// The same run still going: it does say so.
		const again = await waitForTask(sched.scheduledSnapshot(s, 'live'));
		expect(again.log.join('\n')).toMatch(/run "save-on"/);
		expect(reload(s.id).statusMessage).toMatch(/save-on/);
	});
});
