import { startMonitor } from './monitor';
import { startScheduler } from './scheduler';
import { learnJavaRequirement, scanJavaRuntimes } from './java';
import { listInstances } from './instances';
import { stopAllTails } from './journal';
import { recoverInterruptedOperations } from './recovery';
import { removePartialJava } from './javadownload';

/**
 * SvelteKit has no lifecycle hook for "the server started", so hooks.server.ts
 * calls this once. The guard lives on globalThis: in dev, HMR re-evaluates
 * modules, and a module-level flag would start the timers - and recovery -
 * a second time in the same process.
 */
const globals = globalThis as { __mineshellBooted?: boolean };

export function boot(): void {
	if (globals.__mineshellBooted) return;
	globals.__mineshellBooted = true;

	// Before anything else: servers a previous MineShell left mid-operation
	// are put back (and stay marked busy, so unstartable, until then).
	void recoverInterruptedOperations().catch((err) =>
		console.error('[mineshell] recovering interrupted operations failed:', err)
	);

	startMonitor();
	startScheduler();

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
