import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { getInstance, listInstances, setWantedRunning, start } from './instances';
import { runFinishedStarting } from './journal';
import { listOperations } from './operations';
import { unitState } from './systemd';
import { startTask, type TaskHandle } from './tasks';

/**
 * Servers come back after the computer restarts: MineShell starts them itself
 * once it is up, rather than systemd enabling each unit, so that interrupted
 * operations are recovered first (a power cut mid pack change must not boot a
 * half-changed server), a start resolves Java and writes the unit's env file
 * like any other, and big packs start one after another instead of all at once.
 *
 * Only a real boot counts: the kernel's boot id is remembered, and a MineShell
 * restart on the same boot starts nothing. Per server, `bootStart` says
 * if-running (the last thing asked of it was a start: `wantedRunning`),
 * always, or never.
 */

const BOOT_ID_KEY = 'host.bootId';
/** How long one server gets to reach "Done" before the next is started anyway. */
export const BOOT_START_WAIT_MS = 3 * 60_000;
const POLL_MS = 3000;

export function readBootId(): string | null {
	try {
		return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
	} catch {
		return null;
	}
}

/** Null when MineShell runs as a systemd service (and so comes back by itself after a reboot); otherwise why servers will not. */
export function bootStartNote(): string | null {
	if (process.env.INVOCATION_ID) return null;
	return 'MineShell is not running as a systemd service here, so after a reboot nothing starts MineShell, and it cannot start the servers. See "Starting MineShell at boot" in docs/DEPLOYMENT.md.';
}

function readSetting(key: string): string | null {
	return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

function writeSetting(key: string, value: string): void {
	db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/** Which servers to start after a boot, in the order the server list shows them. */
export function serversToStartAfterBoot(): ServerInstance[] {
	const busy = new Set(listOperations().map((o) => o.instanceId));
	return listInstances().filter(
		(i) =>
			i.status === 'ready' &&
			!busy.has(i.id) &&
			(i.bootStart === 'always' || (i.bootStart === 'if-running' && i.wantedRunning))
	);
}

/** Waits until the server has finished starting, stopped, or had BOOT_START_WAIT_MS. */
async function settle(id: string, since: number, waitMs: number): Promise<'started' | 'stopped' | 'waited'> {
	const until = Date.now() + waitMs;
	for (;;) {
		const state = await unitState(id, { fresh: true }).catch(() => null);
		if (!state || state.active === 'inactive' || state.active === 'failed') return 'stopped';
		if (await runFinishedStarting(id, since).catch(() => false)) return 'started';
		if (Date.now() >= until) return 'waited';
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
}

async function startEach(servers: ServerInstance[], task: TaskHandle, waitMs: number): Promise<void> {
	let failed = 0;
	for (const [n, listed] of servers.entries()) {
		const instance = getInstance(listed.id);
		if (!instance) continue;
		task.setProgress((n / servers.length) * 100, `Starting ${instance.name} (${n + 1} of ${servers.length})`);
		const state = await unitState(instance.id, { fresh: true }).catch(() => null);
		if (state && state.active !== 'inactive' && state.active !== 'failed') {
			task.log(`${instance.name}: already running.`);
			continue;
		}
		const since = Date.now();
		const result = await start(instance).catch((err: unknown) => ({
			ok: false,
			message: err instanceof Error ? err.message : String(err)
		}));
		if (!result.ok) {
			failed++;
			task.log(`${instance.name}: not started. ${result.message}`);
			continue;
		}
		const outcome = await settle(instance.id, since, waitMs);
		if (outcome === 'stopped') failed++;
		task.log(
			`${instance.name}: ${
				outcome === 'started'
					? 'started.'
					: outcome === 'stopped'
						? 'stopped while starting; see its console.'
						: `still starting after ${Math.round(waitMs / 60_000)} minutes; going on with the next.`
			}`
		);
	}
	if (failed) throw new Error(`${failed} of ${servers.length} server${servers.length === 1 ? '' : 's'} did not start; the log says why.`);
}

/**
 * Runs at MineShell startup, after interrupted operations are recovered.
 * Returns the task id when servers are being started, null otherwise.
 */
export async function startServersAfterBoot(
	opts: { bootId?: string | null; waitMs?: number } = {}
): Promise<string | null> {
	const bootId = opts.bootId === undefined ? readBootId() : opts.bootId;
	if (!bootId) return null;
	const previous = readSetting(BOOT_ID_KEY);
	writeSetting(BOOT_ID_KEY, bootId);

	if (previous === null) {
		// First start with this feature: nothing tells whether this is a fresh
		// boot. Servers running now count as wanted, so the next reboot brings
		// them back.
		for (const instance of listInstances()) {
			const state = await unitState(instance.id, { fresh: true }).catch(() => null);
			setWantedRunning(instance.id, !!state && state.active !== 'inactive' && state.active !== 'failed');
		}
		return null;
	}
	if (previous === bootId) return null;

	const servers = serversToStartAfterBoot();
	if (servers.length === 0) return null;
	return startTask({ label: `Start ${servers.length} server${servers.length === 1 ? '' : 's'} after the reboot` }, (task) =>
		startEach(servers, task, opts.waitMs ?? BOOT_START_WAIT_MS)
	);
}
