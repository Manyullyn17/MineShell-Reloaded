import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ commands: [] as string[], online: [] as string[] }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map((c) =>
			c === 'list' ? `There are ${rcon.online.length} of a max of 20 players online: ${rcon.online.join(', ')}` : ''
		);
	})
}));

const { evaluateRestart, startScheduler, stopScheduler } = await import('#lib/server/scheduler.js');
const { beginOperation, endOperation } = await import('#lib/server/operations.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance, reload } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');
const { testPorts } = await import('../helpers/ports');
const { db } = await import('#lib/server/db/index.js');
const { auditLog, serverInstances } = await import('#lib/server/db/schema.js');
const { and, eq } = await import('drizzle-orm');

/**
 * Scheduled restarts (scheduler.ts): what one tick of the scheduler does to a
 * server whose restart is due or close. systemd and RCON are faked; the clock
 * is set by hand (only Date: timers stay real).
 */

let active = true;
function fakeUnit() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'journalctl') return { stdout: '[12:00:00] [Server thread/INFO]: Done (3.1s)! For help, type "help"\n' };
		if (cmd !== 'systemctl') return {};
		if (args.includes('show'))
			return { stdout: `ActiveState=${active ? 'active' : 'inactive'}\nSubState=${active ? 'running' : 'dead'}\nActiveEnterTimestampMonotonic=1000\n` };
		invalidateUnitState();
		return {};
	});
}

const MIN = 60_000;
const NOW = new Date(2026, 9, 20, 4, 0).getTime();

async function server(schedule: Partial<typeof serverInstances.$inferInsert> = {}) {
	const s = await createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1', ...testPorts(), rconPasswordEnc: encryptSecret('pw'), eulaAccepted: true },
		{ 'eula.txt': 'eula=true\n' }
	);
	db.update(serverInstances)
		.set({ restartSchedule: 'daily', restartDailyTime: '05:00', restartWarnMinutes: 0, restartSkipIfPlayers: false, ...schedule })
		.where(eq(serverInstances.id, s.id))
		.run();
	return reload(s.id);
}

const setNextIn = (id: string, ms: number) =>
	db.update(serverInstances).set({ restartNextAt: Date.now() + ms }).where(eq(serverInstances.id, id)).run();
const restarted = () => spawnCalls.filter((c) => c.cmd === 'systemctl' && c.args.includes('restart')).length;
const said = () => rcon.commands.filter((c) => c.startsWith('say '));
const audits = (id: string, action: string) =>
	db.select().from(auditLog).where(and(eq(auditLog.instanceId, id), eq(auditLog.action, action))).all();

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	rcon.commands = [];
	rcon.online = [];
	active = true;
	fakeUnit();
	spawnCalls.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	stopScheduler();
});

describe('scheduled restarts', () => {
	it('restarts a running server once it is due, and picks the next day', async () => {
		const s = await server({ restartNextAt: null });
		vi.setSystemTime(new Date(2026, 9, 20, 4, 59, 30).getTime());
		await evaluateRestart(reload(s.id));
		await evaluateRestart(reload(s.id));
		expect(reload(s.id).restartNextAt).toBe(new Date(2026, 9, 20, 5, 0).getTime());
		expect(restarted()).toBe(0);

		vi.setSystemTime(new Date(2026, 9, 20, 5, 0, 10).getTime());
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(1);
		expect(reload(s.id).restartNextAt).toBe(new Date(2026, 9, 21, 5, 0).getTime());
		expect(audits(s.id, 'scheduler.restart')).toHaveLength(1);
	});

	it('warns in game at the marks inside the warning window, each once', async () => {
		const s = await server({ restartWarnMinutes: 10 });
		setNextIn(s.id, 12 * MIN);
		await evaluateRestart(reload(s.id));
		expect(said()).toEqual([]);

		for (const left of [9.5, 9, 4.5, 4, 0.5]) {
			vi.setSystemTime(reload(s.id).restartNextAt! - left * MIN);
			await evaluateRestart(reload(s.id));
		}
		// 15 is outside a 10-minute window; 10, 5 and 1 come once each.
		expect(said()).toEqual(['say Scheduled restart in 10 minutes.', 'say Scheduled restart in 5 minutes.', 'say Scheduled restart in 1 minute.']);
		expect(restarted()).toBe(0);
	});

	it('does not restart a stopped server, and moves the schedule past now so it does not fire on the next start', async () => {
		const s = await server();
		active = false;
		fakeUnit();
		setNextIn(s.id, -MIN);
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(0);
		expect(reload(s.id).restartNextAt).toBeGreaterThan(Date.now());
	});

	it('waits for a journalled operation on the server (a live snapshot) to end', async () => {
		const s = await server();
		setNextIn(s.id, -1000);
		beginOperation(s.id, { kind: 'scheduled-snapshot', mode: 'live', restart: false });
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(0);
		endOperation(s.id);
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(1);
	});

	it('with players online, asks again every two minutes, and restarts once they leave', async () => {
		const s = await server({ restartSkipIfPlayers: true });
		rcon.online = ['Alex', 'Steve'];
		setNextIn(s.id, -1000);
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(0);
		expect(reload(s.id).restartNextAt).toBe(Date.now() + 2 * MIN);

		vi.setSystemTime(Date.now() + 2 * MIN);
		rcon.online = [];
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(1);
		expect(audits(s.id, 'scheduler.restart_forced')).toHaveLength(0);
	});

	it('gives up waiting for players after an hour and restarts anyway', async () => {
		const s = await server({ restartSkipIfPlayers: true });
		rcon.online = ['Alex'];
		setNextIn(s.id, -1000);
		for (let waited = 0; waited < 60; waited += 2) {
			await evaluateRestart(reload(s.id));
			expect(restarted(), `after ${waited} minutes`).toBe(0);
			vi.setSystemTime(Date.now() + 2 * MIN);
		}
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(1);
		expect(audits(s.id, 'scheduler.restart_forced')[0]?.detail).toBe('deferred for an hour with 1 online');

		// The next day's wait starts from nothing again.
		vi.setSystemTime(reload(s.id).restartNextAt! + 1000);
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(1);
	});

	it('only schedules a server that has no next time yet', async () => {
		const s = await server({ restartNextAt: null });
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(0);
		expect(reload(s.id).restartNextAt).toBe(new Date(2026, 9, 20, 5, 0).getTime());
	});

	it('after MineShell was down past a restart time, gives a new slot instead of restarting at once', async () => {
		const s = await server({ restartSchedule: 'interval', restartIntervalHours: 6 });
		setNextIn(s.id, -3 * 60 * MIN);
		startScheduler();
		expect(reload(s.id).restartNextAt).toBe(NOW + 6 * 60 * MIN);
		await evaluateRestart(reload(s.id));
		expect(restarted()).toBe(0);
	});
});
