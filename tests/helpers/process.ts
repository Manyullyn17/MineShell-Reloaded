import { EventEmitter } from 'node:events';

/**
 * Tests never start real processes: tests/setup.ts swaps node:child_process's
 * spawn for fakeSpawn below, which throws unless a test has said what the
 * process should "print". That keeps systemctl, journalctl and java out of
 * every test, by construction rather than by convention.
 *
 *   fakeProcesses((cmd, args) => args.includes('show') ? { stdout: 'ActiveState=active\n' } : {});
 *   ... code under test ...
 *   expect(spawnCalls).toContainEqual({ cmd: 'systemctl', args: [...] });
 */

export type FakeResult = { stdout?: string; stderr?: string; code?: number };
export type SpawnCall = { cmd: string; args: string[] };

let handler: ((cmd: string, args: string[]) => FakeResult | undefined) | null = null;
export const spawnCalls: SpawnCall[] = [];

export function fakeProcesses(fn: (cmd: string, args: string[]) => FakeResult | undefined): void {
	handler = fn;
	spawnCalls.length = 0;
}

export function resetProcesses(): void {
	handler = null;
	spawnCalls.length = 0;
}

export function fakeSpawn(cmd: string, args: readonly string[] = []) {
	if (!handler) {
		throw new Error(
			`Tests must not start real processes (tried: ${cmd} ${args.join(' ')}). Use fakeProcesses() from tests/helpers/process.ts.`
		);
	}
	spawnCalls.push({ cmd, args: [...args] });
	const result = handler(cmd, [...args]) ?? {};
	const child = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		stdin: { write: () => true, end: () => undefined },
		pid: 4242,
		kill: () => true
	});
	setImmediate(() => {
		if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
		if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
		child.emit('close', result.code ?? 0);
	});
	return child;
}

export function forbidden(name: string) {
	return () => {
		throw new Error(`Tests must not start real processes (child_process.${name}).`);
	};
}
