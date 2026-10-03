import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	addScheduledCommand,
	cleanCommand,
	listScheduledCommands,
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
		expect(after.nextAt).toBe(now + 60 * 60_000);
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
		expect(listScheduledCommands(instance.id)[0].nextAt).toBe(row.createdAt + 10 * 60_000);

		setScheduledCommandEnabled(instance.id, row.id, false);
		state('active');
		await runDueCommands(Date.now() + 365 * 24 * 3600_000);
		expect(listScheduledCommands(instance.id)[0].lastRunAt).toBeNull();
	});
});
