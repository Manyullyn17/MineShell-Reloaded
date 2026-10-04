import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { javaRuntimes, serverInstances, type ServerInstance } from '#lib/server/db/schema.js';
import { instanceDir } from '#lib/server/config.js';
import { invalidateUnitState } from '#lib/server/systemd.js';
import { getTask, type Task } from '#lib/server/tasks.js';
import { fakeProcesses } from './process';

/**
 * Building blocks for testing whole flows (pack install, loader switch,
 * Cleanroom migration, pack version change) on throwaway instances. Everything
 * lives in the run's temporary data directory (tests/setup.ts).
 */

let counter = 0;

/**
 * Insert an instance row and create its folder with `files`
 * ({ 'mods/a.jar': 'content', 'libraries/x/y.jar': '...' }).
 */
export async function createInstance(
	fields: Partial<ServerInstance> & Pick<ServerInstance, 'modloader' | 'minecraftVersion'>,
	files: Record<string, string | Buffer> = {}
): Promise<ServerInstance> {
	const id = fields.id ?? `flow-${process.pid}-${++counter}`;
	const dir = instanceDir(id);
	await fs.mkdir(dir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(dir, rel);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	}
	const now = Date.now();
	db.insert(serverInstances)
		.values({
			name: id,
			launchArgs: '-jar server.jar nogui',
			jvmArgs: '-Xms1024M -Xmx2048M',
			status: 'ready',
			createdAt: now,
			updatedAt: now,
			...fields,
			id,
			path: dir
		})
		.run();
	return reload(id);
}

/** The instance row as it is in the database now. */
export function reload(id: string): ServerInstance {
	return db.select().from(serverInstances).where(eq(serverInstances.id, id)).get()!;
}

/** Register a Java runtime as if the scanner had found it (nothing is executed). */
export function addJava(major: number): string {
	const javaPath = `/fake/jvm/java-${major}/bin/java`;
	db.insert(javaRuntimes)
		.values({ path: javaPath, majorVersion: major, versionString: `${major}.0.0`, lastSeenAt: Date.now() })
		.onConflictDoNothing()
		.run();
	return javaPath;
}

/**
 * Forget every registered Java runtime. The test database is shared by all
 * test files, so a test that depends on which Java is (not) installed must
 * start from a clean list.
 */
export function clearJava(): void {
	db.delete(javaRuntimes).run();
}

/** systemctl answers "stopped" to status reads and succeeds at everything else. */
export function systemdStopped(): void {
	invalidateUnitState();
	fakeProcesses((cmd, args) =>
		args.includes('show') ? { stdout: 'ActiveState=inactive\nSubState=dead\nResult=success\n' } : {}
	);
}

/** Wait for a background task (startTask) to finish and return it. */
export async function waitForTask(id: string, timeoutMs = 4000): Promise<Task> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const task = getTask(id);
		if (task && task.state !== 'running') return task;
		if (Date.now() > until) throw new Error(`Task ${id} still running after ${timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

/**
 * Wait until an instance is no longer "provisioning". A failed task's status is
 * flipped by a watcher that checks once a second (watchTaskFailure).
 */
export async function waitForStatusSettled(id: string, timeoutMs = 4000): Promise<ServerInstance> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const row = reload(id);
		if (row.status !== 'provisioning') return row;
		if (Date.now() > until) throw new Error(`Instance ${id} still provisioning after ${timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/**
 * Every file under `dir` with its content, for before/after comparisons.
 * Paths matching `ignore` are skipped.
 */
export async function tree(dir: string, ignore: RegExp = /^\.mineshell\//): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	async function walk(rel: string) {
		const abs = path.join(dir, rel);
		for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (ignore.test(child + (entry.isDirectory() ? '/' : ''))) continue;
			if (entry.isDirectory()) await walk(child);
			else out[child] = await fs.readFile(path.join(dir, child), 'utf8');
		}
	}
	await walk('');
	return out;
}
