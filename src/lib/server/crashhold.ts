import { audit, getInstance } from './instances';
import { isUnitStart, lastRun } from './crashdiag';
import { diagnoseLastRun } from './lastcrash';
import { noteRestartHeld } from './history';
import { readLastRun } from './journal';
import { stopUnit } from './systemd';

/**
 * A crash while starting that a restart cannot change (a mod missing its dependency, a mod for
 * another loader): systemd would restart it up to the crash limit, each start failing the same
 * way, and the person waits out the loop before they can use the fix. With the server's
 * "Don't restart after a startup crash that has a fix" on (the default), the restart systemd
 * scheduled is cancelled when the crashed run never reached "Done (" and the diagnosis that
 * stopped it has a one-click fix (enable, disable, install). Not the watchdog: it ends a server
 * after "Done (", where a slow tick may pass on a retry.
 *
 * Called by the monitor for a unit in `auto-restart` (RestartSec=15, the monitor every 10 s).
 * The cancel is a plain `systemctl stop`, not MineShell's stop, so the crash still shows as one.
 */
const handled = new Set<string>();

export async function holdFixableRestart(instanceId: string, invocation: string): Promise<boolean> {
	const key = `${instanceId}:${invocation}`;
	if (handled.has(key)) return false;
	handled.add(key);
	const instance = getInstance(instanceId);
	if (!instance?.autoRestartOnCrash || !instance.crashRestartSkipFixable) return false;
	const log = lastRun(await readLastRun(instanceId, instance.createdAt));
	if (!isUnitStart(log) || /\]: Done \(/.test(log)) return false;
	const stopped = (await diagnoseLastRun(instance, log)).find((d) => d.fatal && (d.fix || d.install));
	if (!stopped) return false;
	await stopUnit(instanceId);
	noteRestartHeld(instanceId, Date.now());
	audit('instance.crash_restart_held', { instanceId, detail: stopped.title, actor: 'scheduler' });
	return true;
}
