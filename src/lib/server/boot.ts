import { startMonitor } from './monitor';
import { startScheduler } from './scheduler';
import { learnJavaRequirement, scanJavaRuntimes } from './java';
import { listInstances } from './instances';
import { stopAllTails } from './journal';

/**
 * SvelteKit has no lifecycle hook for "the server started", so hooks.server.ts
 * calls this once. The guard matters in dev, where HMR re-evaluates modules.
 */
let booted = false;

export function boot(): void {
	if (booted) return;
	booted = true;

	startMonitor();
	startScheduler();

	// Non-blocking: the first instance creation triggers a rescan anyway.
	void scanJavaRuntimes().catch((err) =>
		console.warn('[mineshell] Java scan failed:', err instanceof Error ? err.message : err)
	);

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
