/**
 * What happens to a rejection nothing caught. Node's default ends the process
 * on one; systemd then restarts MineShell, which drops every running task
 * (installs, exports, a countdown) and, when the cause persists (a full disk
 * failing a database write), does so again and again. A rejected promise only
 * ends the work it belonged to, so it is logged and MineShell keeps running.
 *
 * A synchronous throw nothing caught (uncaughtException) still ends the
 * process: it can leave work half done in ways nobody can see, and the
 * restart, with recovery of journalled operations, is the safer way back.
 */

/** Logged to the journal, with the stack: it is a bug to fix where it was thrown. */
export function logUnhandledRejection(reason: unknown): void {
	console.error('[mineshell] an error nothing caught; MineShell keeps running:', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
}

const globals = globalThis as { __mineshellRejectionGuard?: boolean };

/** Once per process (dev HMR re-runs module code). */
export function keepRunningOnRejections(): void {
	if (globals.__mineshellRejectionGuard) return;
	globals.__mineshellRejectionGuard = true;
	process.on('unhandledRejection', logUnhandledRejection);
}
