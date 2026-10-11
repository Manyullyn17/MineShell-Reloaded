import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from './db';
import { heapSamples, serverInstances } from './db/schema';
import { unitState } from './systemd';

/**
 * How much of the Java heap a running server uses, for memory advice. The
 * cgroup's memory (monitor.ts) cannot say: the JVM keeps heap it has taken,
 * and with -Xms = -Xmx it takes all of it at start.
 *
 * The JVM is asked over its attach socket, the way `jcmd <pid> GC.heap_info`
 * does, so no JDK tools and no JVM flags are needed (the hsperfdata file jstat
 * reads is switched off by -XX:+PerfDisableSharedMem, in Aikar's flags). The
 * socket appears after a SIGQUIT while a `.attach_pid<pid>` file exists; the
 * JVM then starts its attach listener instead of printing a thread dump.
 * Measured on Java 8, 17, 21 and 25 with G1, Parallel, ZGC and Shenandoah:
 * nothing logged, the trigger file removed.
 *
 * A SIGQUIT the JVM does not handle ends the process, so it is never sent to
 * one started with -Xrs or with attach turned off, nor to one under a minute
 * old (the handler is installed early, but not first), nor twice to a process
 * that did not answer.
 */

const SAMPLE_EVERY_MS = 60_000;
export const HEAP_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MIN_PROCESS_AGE_S = 60;
const ANSWER_TIMEOUT_MS = 5000;

/**
 * Processes that did not open the socket when asked: never signalled again.
 * Keyed by pid and start time, so a reused pid is a new process.
 */
const unanswered = new Set<string>();
/** -XX:MaxHeapSize by process, read once. */
const maxHeap = new Map<string, number>();

/** "used" from GC.heap_info, in bytes, for every collector's way of printing it. */
export function parseHeapInfo(text: string): number | null {
	const unit = (n: string, u: string) => Number(n) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[u as 'K' | 'M' | 'G'];
	let used = 0;
	let found = false;
	for (const line of text.split('\n')) {
		// Metaspace is not heap; "eden space 65536K, 68% used" repeats its generation's figure.
		if (/Metaspace|class space|^\s{2,}/.test(line)) continue;
		// G1, Parallel, Serial, ZGC: "..., used 113796K"; Shenandoah: "256M committed, 43008K used".
		const m = line.match(/\bused (\d+)([KMG])\b/) ?? line.match(/\b(\d+)([KMG]) used\b/);
		if (m) {
			used += unit(m[1], m[2]);
			found = true;
		}
	}
	return found ? used : null;
}

/** -XX:MaxHeapSize=268435456 from VM.flags. */
export function parseMaxHeap(text: string): number | null {
	const m = text.match(/-XX:MaxHeapSize=(\d+)/);
	return m ? Number(m[1]) : null;
}

/**
 * The heap a java command line asks for, in bytes: -Xmx or -XX:MaxHeapSize,
 * the last one counting, as in Java. Null when neither is there (an @argfile).
 */
export function parseHeapArg(args: string[]): number | null {
	let bytes: number | null = null;
	for (const arg of args) {
		const m = arg.match(/^(?:-Xmx|-XX:MaxHeapSize=)(\d+)([kmgt]?)$/i);
		if (m) bytes = Number(m[1]) * 1024 ** ' kmgt'.indexOf((m[2] || ' ').toLowerCase());
	}
	return bytes;
}

/**
 * The maximum heap the running process `pid` was started with, in MB. Memory
 * settings saved while a server runs apply from its next start, so this, not
 * the saved value, is what the server has now.
 */
export async function runningHeapMb(pid: number | null | undefined): Promise<number | null> {
	if (!pid) return null;
	try {
		const bytes = parseHeapArg((await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'));
		return bytes === null ? null : Math.round(bytes / 1024 ** 2);
	} catch {
		return null;
	}
}

/** Whether a SIGQUIT can only start the attach listener, judging by the command line. */
export function safeToSignal(args: string[]): boolean {
	return !args.some((a) => a === '-Xrs' || a === '-XX:+ReduceSignalUsage' || a === '-XX:+DisableAttachMechanism');
}

/** When the process started, in clock ticks (USER_HZ, 100) since boot. */
async function startTicks(pid: number): Promise<number> {
	const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
	// The name in parentheses can hold spaces; the fields after it are fixed. starttime is field 22.
	return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}

async function processAgeSeconds(pid: number): Promise<number> {
	const uptime = Number((await fs.readFile('/proc/uptime', 'utf8')).split(' ')[0]);
	return uptime - (await startTicks(pid)) / 100;
}

/** Runs a diagnostic command in the JVM `pid`; null if it cannot be asked. */
export async function jvmCommand(pid: number, command: string): Promise<string | null> {
	const key = `${pid}:${await startTicks(pid)}`;
	if (unanswered.has(key)) return null;
	// Through the process's own root: the unit has PrivateTmp, so its /tmp is not ours.
	const socket = `/proc/${pid}/root/tmp/.java_pid${pid}`;
	if (!(await exists(socket))) {
		const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
		if (path.basename(await fs.readlink(`/proc/${pid}/exe`)) !== 'java' || !safeToSignal(args)) return null;
		if ((await processAgeSeconds(pid)) < MIN_PROCESS_AGE_S) return null;
		const trigger = `/proc/${pid}/cwd/.attach_pid${pid}`;
		try {
			await fs.writeFile(trigger, '');
		} catch {
			// Without the file the signal would print a thread dump instead.
			return null;
		}
		try {
			process.kill(pid, 'SIGQUIT');
			for (let i = 0; i < 50 && !(await exists(socket)); i++) await sleep(100);
		} finally {
			await fs.rm(trigger, { force: true });
		}
		if (!(await exists(socket))) {
			unanswered.add(key);
			return null;
		}
	}
	return ask(socket, command);
}

/** Protocol 1: "1", the operation, three arguments, each NUL-terminated; the answer starts with its status line. */
function ask(socket: string, command: string): Promise<string | null> {
	return new Promise((resolve) => {
		const client = net.createConnection(socket);
		let out = '';
		const done = (value: string | null) => {
			clearTimeout(timer);
			client.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => done(null), ANSWER_TIMEOUT_MS);
		client.on('connect', () => client.write(['1', 'jcmd', command, '', ''].join('\0') + '\0'));
		client.on('data', (d) => (out += d.toString()));
		client.on('end', () => {
			const nl = out.indexOf('\n');
			done(nl > 0 && out.slice(0, nl).trim() === '0' ? out.slice(nl + 1) : null);
		});
		client.on('error', () => done(null));
	});
}

export type HeapReading = { usedBytes: number; maxBytes: number };

export async function readHeap(pid: number): Promise<HeapReading | null> {
	const key = `${pid}:${await startTicks(pid)}`;
	let max = maxHeap.get(key);
	if (max === undefined) {
		const flags = await jvmCommand(pid, 'VM.flags');
		const parsed = flags ? parseMaxHeap(flags) : null;
		if (!parsed) return null;
		maxHeap.set(key, (max = parsed));
	}
	const info = await jvmCommand(pid, 'GC.heap_info');
	const used = info ? parseHeapInfo(info) : null;
	return used === null ? null : { usedBytes: used, maxBytes: max };
}

async function sampleOnce(): Promise<void> {
	const now = Date.now();
	for (const { id } of db.select({ id: serverInstances.id }).from(serverInstances).all()) {
		try {
			const state = await unitState(id);
			if (state.active !== 'active' || state.sub !== 'running' || !state.mainPid) continue;
			const reading = await readHeap(state.mainPid);
			if (reading) db.insert(heapSamples).values({ instanceId: id, timestamp: now, ...reading }).run();
		} catch {
			// Gone between the state read and the question: the next minute tries again.
		}
	}
	db.delete(heapSamples).where(lt(heapSamples.timestamp, now - HEAP_RETENTION_MS)).run();
}

let timer: NodeJS.Timeout | null = null;

export function startHeapSampling(): void {
	if (timer) return;
	timer = setInterval(() => void sampleOnce(), SAMPLE_EVERY_MS);
	timer.unref?.();
}

export type HeapSample = { timestamp: number; usedBytes: number; maxBytes: number };

export function heapSamplesSince(instanceId: string, since: number): HeapSample[] {
	return db
		.select({ timestamp: heapSamples.timestamp, usedBytes: heapSamples.usedBytes, maxBytes: heapSamples.maxBytes })
		.from(heapSamples)
		.where(and(eq(heapSamples.instanceId, instanceId), gte(heapSamples.timestamp, since)))
		.orderBy(heapSamples.timestamp)
		.all();
}

const exists = (p: string) => fs.access(p).then(
	() => true,
	() => false
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
