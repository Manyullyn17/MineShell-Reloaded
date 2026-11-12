import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ commands: [] as string[], down: false }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		if (rcon.down) throw new Error('connection refused');
		rcon.commands.push(...commands);
		return commands.map(() => '');
	})
}));

const { restart, stop, summarise, GRACEFUL_STOP_MS } = await import('#lib/server/instances.js');
const { getInstance } = await import('#lib/server/instances.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { db } = await import('#lib/server/db/index.js');
const { serverInstances } = await import('#lib/server/db/schema.js');
const { eq } = await import('drizzle-orm');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');
const { testPorts } = await import('../helpers/ports');

/**
 * Restart over RCON (instances.ts, `restart`): saved and stopped as Stop does, given its five
 * minutes to exit, then started as Start starts it. It was `systemctl restart`, whose SIGTERM
 * systemd follows with SIGKILL after three minutes: a big pack still saving was cut short by
 * Restart only. systemd and RCON are faked; the stop's timers run on a fake clock.
 */

let active = 'active';
function unit() {
	active = 'active';
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd !== 'systemctl') return {};
		if (args.includes('show')) return { stdout: `ActiveState=${active}\nSubState=x\n` };
		if (args.includes('stop')) active = 'inactive';
		if (args.includes('start')) active = 'active';
		invalidateUnitState();
		return {};
	});
}
const exited = () => {
	active = 'inactive';
	invalidateUnitState();
};
const verbs = () => spawnCalls.filter((c) => c.cmd === 'systemctl' && ['start', 'stop', 'restart'].includes(c.args[1])).map((c) => c.args[1]);

async function server() {
	return createInstance(
		{ modloader: 'vanilla', minecraftVersion: '1.21.1', ...testPorts(), rconPasswordEnc: encryptSecret('pw'), eulaAccepted: true },
		{ 'eula.txt': 'eula=true\n' }
	);
}

// Only the clock the stop waits on: the fake processes answer through setImmediate.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	rcon.commands = [];
	rcon.down = false;
	unit();
	spawnCalls.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('Restart over RCON', () => {
	it('saves and stops the server as Stop does, lets a slow save finish, then starts it', async () => {
		const s = await server();
		expect(await restart(s)).toEqual({ ok: true, message: 'Saving and restarting.' });
		expect(rcon.commands).toEqual(['save-all', 'stop']);
		// Four minutes in, still saving: systemd's restart had killed it a minute ago.
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(verbs()).toEqual([]);
		expect(await summarise(s)).toMatchObject({ running: true, stopping: true });
		exited();
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(verbs()).toEqual(['start']));
	});

	it('stops it through systemd after the five minutes, then starts it', async () => {
		const s = await server();
		await restart(s);
		await vi.advanceTimersByTimeAsync(GRACEFUL_STOP_MS + 5000);
		await vi.waitFor(() => expect(verbs()).toEqual(['stop', 'start']));
	});

	it('does not start a server stopped while it was saving', async () => {
		const s = await server();
		await restart(s);
		await vi.advanceTimersByTimeAsync(10_000);
		// Stop's own RCON stop finds the server already going down.
		rcon.down = true;
		await stop(s);
		exited();
		await vi.advanceTimersByTimeAsync(GRACEFUL_STOP_MS * 2);
		// Time on the real clock too, for a start's port checks and set-up to have got to systemd.
		vi.useRealTimers();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(verbs()).not.toContain('start');
	});

	it('says on the overview when the server stopped but could not start again', async () => {
		const s = await server();
		await restart(s);
		db.update(serverInstances).set({ status: 'provisioning' }).where(eq(serverInstances.id, s.id)).run();
		exited();
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(getInstance(s.id)?.statusMessage).toBeTruthy());
		expect(verbs()).toEqual([]);
		expect(getInstance(s.id)?.statusMessage).toBe('The server stopped for its restart but did not start again: This instance is still being set up.');
	});

	it('is systemd\'s restart when RCON does not answer (still starting)', async () => {
		const s = await server();
		rcon.down = true;
		expect(await restart(s)).toEqual({ ok: true, message: 'Restarting.' });
		expect(verbs()).toEqual(['restart']);
	});
});
