import { startServersAfterBoot } from './bootstart';
import { startMonitor } from './monitor';
import { startHeapSampling } from './heap';
import { startHistory } from './history';
import { startScheduler } from './scheduler';
import { learnJavaRequirement, scanJavaRuntimes } from './java';
import { listInstances, syncUnit } from './instances';
import { restoredThisStart } from './db/restore';
import { stopAllTails } from './journal';
import { recoverInterruptedOperations } from './recovery';
import { removePartialJava } from './javadownload';
import { refreshTemplateUnit } from './systemd';
import { applyServerCap } from './servercap';
import { startUpdateChecks } from './selfupdate';
import { startBackups } from './backups';
import { keepRunningOnRejections } from './crashguard';

/**
 * SvelteKit has no lifecycle hook for "the server started", so hooks.server.ts
 * calls this once. The guard lives on globalThis: in dev, HMR re-evaluates
 * modules, and a module-level flag would start the timers - and recovery -
 * a second time in the same process.
 */
const globals = globalThis as { __mineshellBooted?: boolean };

async function resyncUnits(): Promise<void> {
	for (const instance of listInstances()) {
		await syncUnit(instance).catch((err) => console.warn(`[mineshell] syncing ${instance.id}'s unit failed:`, err instanceof Error ? err.message : err));
	}
}

export function boot(): void {
	if (globals.__mineshellBooted) return;
	globals.__mineshellBooted = true;
	keepRunningOnRejections();

	// Before anything else: servers a previous MineShell left mid-operation
	// are put back (and stay marked busy, so unstartable, until then).
	// Then, after a reboot, the servers that should come back are started
	// (bootstart.ts); only once recovery is done, so none starts half-changed.
	void recoverInterruptedOperations()
		.catch((err) => console.error('[mineshell] recovering interrupted operations failed:', err))
		// A database copy put back at this start: each server's unit as its restored row says.
		.then(() => (restoredThisStart() ? resyncUnits() : undefined))
		.then(() => startServersAfterBoot())
		.then((taskId) => taskId && console.log('[mineshell] starting servers after the reboot'))
		.catch((err) => console.error('[mineshell] starting servers after the reboot failed:', err));

	void refreshTemplateUnit()
		.then((refreshed) => refreshed && console.log('[mineshell] updated the systemd template unit'))
		.catch((err) => console.warn('[mineshell] refreshing the template unit failed:', err instanceof Error ? err.message : err))
		.then(() => applyServerCap())
		.catch((err) => console.warn('[mineshell] setting the cap on all servers failed:', err instanceof Error ? err.message : err));

	startMonitor();
	startHeapSampling();
	startScheduler();
	startHistory();
	startUpdateChecks();
	startBackups();

	// Non-blocking: the first instance creation triggers a rescan anyway. A
	// Java download cut short leaves a .partial folder, removed first.
	void removePartialJava()
		.then(scanJavaRuntimes)
		.catch((err) => console.warn('[mineshell] Java scan failed:', err instanceof Error ? err.message : err));

	// Learn the Java each existing instance's Minecraft version needs, so
	// versions newer than the built-in rules (26.x needs Java 25) resolve right.
	void (async () => {
		for (const mc of new Set(listInstances().map((i) => i.minecraftVersion))) {
			await learnJavaRequirement(mc);
		}
	})();

	const shutdown = () => {
		stopAllTails();
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);

	console.log('[mineshell] background services started');
}
