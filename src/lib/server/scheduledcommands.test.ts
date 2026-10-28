import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	addScheduledCommand,
	cleanCommand,
	listScheduledCommands,
	minuteSlot,
	nextRunAt,
	rollForwardMissed,
	runDueCommands,
	setScheduledCommandEnabled
} from './scheduledcommands';
import { db } from './db';
import { scheduledCommands } from './db/schema';
import { invalidateUnitState } from './systemd';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';
import { createInstance } from '../../../tests/helpers/instances';

const state = (active: string) => {
	invalidateUnitState();
	fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: `ActiveState=${active}\n` } : {}));
};

describe('scheduled commands', () => {
	it('works out the next slot for intervals and times of day', () => {
		const from = new Date(2026, 9, 3, 10, 30).getTime();
		expect(nextRunAt({ everyMinutes: 15, dailyTime: null }, from)).toBe(new Date(2026, 9, 3, 10, 45).getTime());
		expect(nextRunAt({ everyMinutes: 180, dailyTime: null }, from)).toBe(new Date(2026, 9, 3, 12, 0).getTime());
		// An interval that does not divide a day (set before the choices) counts on from `from`.
		expect(nextRunAt({ everyMinutes: 90, dailyTime: null }, from)).toBe(from + 90 * 60_000);
		expect(new Date(nextRunAt({ everyMinutes: null, dailyTime: '04:00' }, from)!).getDate()).toBe(4);
		expect(new Date(nextRunAt({ everyMinutes: null, dailyTime: '23:15' }, from)!).getHours()).toBe(23);
	});

	it('takes commands as typed in chat too', () => {
		expect(cleanCommand('  /say hi\n')).toBe('say hi');
	});

	it('moves a stopped server\'s due command to its next slot without running it', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const row = addScheduledCommand(instance.id, 'save-all', { everyMinutes: 60 });
		const now = row.nextAt! + 1000;
		state('inactive');
		await runDueCommands(now);
		const [after] = listScheduledCommands(instance.id);
		expect(after.lastRunAt).toBeNull();
		expect(after.nextAt).toBe(minuteSlot(60, now));
	});

	it('records what happened when it runs on a running server', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', rconPort: 1 });
		const row = addScheduledCommand(instance.id, 'say hello', { everyMinutes: 30 });
		state('active');
		await runDueCommands(row.nextAt! + 1);
		const [after] = listScheduledCommands(instance.id);
		expect(after.lastRunAt).toBe(row.nextAt! + 1);
		// No RCON password on this test server: recorded as a failure, not thrown.
		expect(after.lastResult).toMatch(/^Failed: RCON is not set up/);
		expect(spawnCalls.some((c) => c.args.includes('show'))).toBe(true);
	});

	it('skips slots missed while MineShell was down, and paused ones', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const row = addScheduledCommand(instance.id, 'save-all', { everyMinutes: 10 });
		db.update(scheduledCommands).set({ nextAt: 5 }).where(eq(scheduledCommands.id, row.id)).run();
		rollForwardMissed(row.createdAt);
		expect(listScheduledCommands(instance.id)[0].nextAt).toBe(minuteSlot(10, row.createdAt));

		setScheduledCommandEnabled(instance.id, row.id, false);
		state('active');
		await runDueCommands(Date.now() + 365 * 24 * 3600_000);
		expect(listScheduledCommands(instance.id)[0].lastRunAt).toBeNull();
	});

	it('run on the clock: every 30 minutes at :00 and :30, from any minute and across midnight', () => {
		let at = new Date(2026, 9, 3, 23, 7, 12).getTime();
		const slots: string[] = [];
		for (let i = 0; i < 3; i++) {
			at = minuteSlot(30, at);
			const d = new Date(at);
			slots.push(`${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
		}
		expect(slots).toEqual(['3 23:30', '4 0:00', '4 0:30']);
	});

	it('never gives a slot before now in the hour the autumn clock change repeats', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'Europe/Vienna';
		try {
			// 02:15 the second time (CET): counting from midnight gave 02:30 summer time,
			// an hour before, and the command ran at every check.
			const from = Date.parse('2026-10-25T02:15:00+01:00');
			expect(minuteSlot(15, from)).toBe(Date.parse('2026-10-25T02:30:00+01:00'));
			expect(minuteSlot(15, Date.parse('2026-10-25T02:45:00+02:00'))).toBe(Date.parse('2026-10-25T02:00:00+01:00'));
		} finally {
			process.env.TZ = tz;
		}
	});

	it('moves an interval set before it fell on the clock onto it at startup', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const row = addScheduledCommand(instance.id, 'save-all', { everyMinutes: 60 });
		const now = Date.now();
		const offClock = minuteSlot(60, now) + 17 * 60_000;
		db.update(scheduledCommands).set({ nextAt: offClock }).where(eq(scheduledCommands.id, row.id)).run();
		rollForwardMissed(now);
		expect(listScheduledCommands(instance.id)[0].nextAt).toBe(minuteSlot(60, now));
	});
});
