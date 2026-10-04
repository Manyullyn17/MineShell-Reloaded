import fs from 'node:fs/promises';
import { vi } from 'vitest';
import { db } from '#lib/server/db/index.js';
import { operations } from '#lib/server/db/schema.js';
import { recoverInterruptedOperations } from '#lib/server/recovery.js';
import { waitForTask } from './instances';

/**
 * Simulating MineShell dying in the middle of an operation. A test cannot
 * kill its own process, so the operation is frozen instead: at its n-th file
 * move into the server folder, that move and every later one hang forever.
 * Parallel work still in flight gets as far as it would before a real crash
 * (half-written download .part files included) and then stops at its own
 * next move. restartMineShell() lifts the freeze - nothing of the "dead"
 * operation is still moving by then - makes the journal look like a previous
 * process's, and runs recovery.
 */
export async function runAndDieAtMove(
	root: string,
	n: number,
	start: () => Promise<string>
): Promise<'died' | 'finished'> {
	const realRename = fs.rename.bind(fs);
	let moves = 0;
	let dead = false;
	let died!: () => void;
	const reached = new Promise<'died'>((resolve) => (died = () => resolve('died')));
	vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
		if (dead || (String(to).startsWith(root) && ++moves === n)) {
			dead = true;
			died();
			return new Promise<void>(() => {});
		}
		return realRename(from, to);
	});
	const finished = start()
		.then(waitForTask)
		.then(() => 'finished' as const);
	const outcome = await Promise.race([reached, finished]);
	if (outcome === 'died') {
		// Let in-flight work run into the dead end.
		await new Promise((resolve) => setTimeout(resolve, 50));
	} else {
		vi.mocked(fs.rename).mockRestore();
	}
	return outcome;
}

/** The next MineShell start: the journal now belongs to a process that is gone. */
export async function restartMineShell() {
	if (vi.isMockFunction(fs.rename)) vi.mocked(fs.rename).mockRestore();
	db.update(operations).set({ process: 'previous-process' }).run();
	return recoverInterruptedOperations();
}

/** An operation that freezes at a point of the test's choosing, e.g. inside a loader install. */
export function hangForever(): Promise<never> {
	return new Promise(() => {});
}
