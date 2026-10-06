import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const rcon = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map(() => '');
	})
}));

const { startServersAfterBoot, serversToStartAfterBoot } = await import('#lib/server/bootstart.js');
const { listInstances, setWantedRunning, start, stop, sendCommand } = await import('#lib/server/instances.js');
const { beginOperation, endOperation } = await import('#lib/server/operations.js');
const { db } = await import('#lib/server/db/index.js');
const { serverInstances, settings } = await import('#lib/server/db/schema.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { createInstance, reload, waitForTask } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

/** A fake systemd: units start when asked and stay up; started ones have "Done (" in the journal. */
let active = new Set<string>();
let started: string[] = [];
let failing = new Set<string>();
function fakeSystemd() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		const unit = args.find((a) => a.includes('@'));
		const id = unit?.replace(/^.*@/, '').replace(/\.service$/, '') ?? '';
		if (cmd === 'systemctl' && args.includes('start')) {
			if (failing.has(id)) return { code: 1, stderr: 'Job failed.' };
			started.push(id);
			active.add(id);
			invalidateUnitState();
			return {};
		}
		if (cmd === 'systemctl' && args.includes('show')) {
			return { stdout: active.has(id) ? 'ActiveState=active\nSubState=running\nResult=success\n' : 'ActiveState=inactive\nSubState=dead\nResult=success\n' };
		}
		if (cmd === 'journalctl') return { stdout: '[12:00:00] [Server thread/INFO]: Done (3.2s)! For help, type "help"\n' };
		return {};
	});
}

/** start() checks the ports are free: ones of their own, not 25565 (which a real server here may hold). */
let port = 47100 + (process.pid % 400) * 20;
async function server(fields: Partial<typeof serverInstances.$inferSelect> = {}) {
	port += 2;
	return createInstance(
		{ modloader: 'vanilla', minecraftVersion: '1.20.1', eulaAccepted: true, serverPort: port, rconPort: port + 1, ...fields },
		{ 'eula.txt': 'eula=true\n', 'server.jar': 'jar' }
	);
}

const setBootId = (value: string | null) => {
	db.delete(settings).where(eq(settings.key, 'host.bootId')).run();
	if (value) db.insert(settings).values({ key: 'host.bootId', value }).run();
};

beforeEach(() => {
	// Earlier tests' servers would be started too.
	for (const i of listInstances()) db.update(serverInstances).set({ bootStart: 'never' }).where(eq(serverInstances.id, i.id)).run();
	active = new Set();
	started = [];
	failing = new Set();
	fakeSystemd();
});

describe('starting servers after a reboot', () => {
	it('remembers what was last asked: start and restart want it running, stop and a console stop do not', async () => {
		const s = await server({ rconPasswordEnc: encryptSecret('pw') });
		expect(reload(s.id).wantedRunning).toBe(false);
		expect((await start(s)).ok).toBe(true);
		expect(reload(s.id).wantedRunning).toBe(true);
		await stop(reload(s.id), { graceful: false });
		expect(reload(s.id).wantedRunning).toBe(false);
		setWantedRunning(s.id, true);
		await sendCommand(reload(s.id), 'say hi');
		expect(reload(s.id).wantedRunning).toBe(true);
		await sendCommand(reload(s.id), '/stop');
		expect(reload(s.id).wantedRunning).toBe(false);
	});

	it('picks always, and if-running when it was; never, failed and busy servers stay off', async () => {
		const wanted = await server({ bootStart: 'if-running', wantedRunning: true });
		await server({ bootStart: 'if-running', wantedRunning: false });
		const always = await server({ bootStart: 'always' });
		await server({ bootStart: 'never', wantedRunning: true });
		await server({ bootStart: 'always', status: 'failed' });
		const busy = await server({ bootStart: 'always' });
		beginOperation(busy.id, { kind: 'create' });
		try {
			expect(serversToStartAfterBoot().map((i) => i.id)).toEqual([wanted.id, always.id]);
		} finally {
			endOperation(busy.id);
		}
	});

	it('starts them one after another after a new boot, and nothing on a MineShell restart', async () => {
		const a = await server({ bootStart: 'always' });
		const b = await server({ bootStart: 'if-running', wantedRunning: true });
		setBootId('boot-1');
		expect(await startServersAfterBoot({ bootId: 'boot-1' })).toBeNull();
		expect(started).toEqual([]);

		const taskId = await startServersAfterBoot({ bootId: 'boot-2', waitMs: 1000 });
		expect(taskId).not.toBeNull();
		const task = await waitForTask(taskId!, 8000);
		expect(task.error).toBeNull();
		expect(started).toEqual([a.id, b.id]);
		expect(task.log).toEqual([`${a.name}: started.`, `${b.name}: started.`]);
	});

	it('goes on past a server that will not start, and says so', async () => {
		const bad = await server({ bootStart: 'always' });
		const good = await server({ bootStart: 'always' });
		failing.add(bad.id);
		setBootId('boot-3');
		const task = await waitForTask((await startServersAfterBoot({ bootId: 'boot-4', waitMs: 1000 }))!, 8000);
		expect(started).toEqual([good.id]);
		expect(task.state).toBe('failed');
		expect(task.log[0]).toMatch(new RegExp(`^${bad.name}: not started\\.`));
	});

	it('on its first run only records which servers are running, starting none', async () => {
		const up = await server({ bootStart: 'always' });
		const down = await server({ bootStart: 'always', wantedRunning: true });
		active.add(up.id);
		setBootId(null);
		expect(await startServersAfterBoot({ bootId: 'boot-5' })).toBeNull();
		expect(started).toEqual([]);
		expect(reload(up.id).wantedRunning).toBe(true);
		expect(reload(down.id).wantedRunning).toBe(false);
	});
});
