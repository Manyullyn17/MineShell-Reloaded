import fs from 'node:fs/promises';
import type { ServerInstance } from './db/schema';
import { parseHeapArg, runningHeapMb } from './heap';
import { minMemoryLimitMb } from '#lib/shared/memorylimit.js';

/**
 * Before a start asked for by hand: does the machine have the memory for this
 * server, with room left for the servers already running to grow into their
 * heaps? When memory runs out the kernel ends the biggest process, which is
 * a server (and not necessarily the one just started), so the start warns
 * and can go ahead anyway. Never for starts nobody watches (schedules, boot).
 */

/** At most what Java takes: the heap plus what it needs beyond it, or the server's memory limit if smaller. */
export function ceilingMb(heapMb: number, limitMb: number | null): number {
	const ceiling = minMemoryLimitMb(heapMb);
	return limitMb ? Math.min(limitMb, ceiling) : ceiling;
}

export type RunningUse = { name: string; ceilingMb: number; usedMb: number };

/**
 * The warning for a start, or null when it fits: what the new server can take
 * plus what the running ones can still grow by, against what is available.
 */
export function memoryWarning(input: { name: string; heapMb: number; needMb: number; availableMb: number; running: RunningUse[] }): string | null {
	const growth = input.running.map((r) => ({ ...r, growthMb: Math.max(0, r.ceilingMb - r.usedMb) }));
	const growthMb = growth.reduce((sum, r) => sum + r.growthMb, 0);
	if (input.needMb + growthMb <= input.availableMb) return null;
	const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
	const growing = growth.filter((r) => r.growthMb > 0);
	return (
		`${input.name} can take up to ${gb(input.needMb)} (its ${gb(input.heapMb)} heap and what Java needs beyond it), and ${gb(input.availableMb)} is available` +
		(growing.length ? `, with ${growing.map((r) => r.name).join(', ')} able to grow by ${gb(growthMb)} more` : '') +
		'. If memory runs out, the system ends the biggest process, usually a server.'
	);
}

/** MemAvailable from /proc/meminfo: free memory plus what the kernel can reclaim. Null if unreadable. */
export async function availableMb(): Promise<number | null> {
	try {
		const kb = (await fs.readFile('/proc/meminfo', 'utf8')).match(/^MemAvailable:\s+(\d+) kB/m)?.[1];
		return kb ? Math.floor(Number(kb) / 1024) : null;
	} catch {
		return null;
	}
}

async function residentMb(pid: number): Promise<number | null> {
	try {
		const kb = (await fs.readFile(`/proc/${pid}/status`, 'utf8')).match(/^VmRSS:\s+(\d+) kB/m)?.[1];
		return kb ? Math.floor(Number(kb) / 1024) : null;
	} catch {
		return null;
	}
}

/** The heap a server is configured for: the memory field, else -Xmx in its JVM arguments. */
function configuredHeapMb(instance: ServerInstance): number | null {
	if (instance.memoryMaxMb) return instance.memoryMaxMb;
	const bytes = parseHeapArg(instance.jvmArgs.split(/\s+/));
	return bytes === null ? null : Math.round(bytes / 1024 ** 2);
}

/**
 * The warning for starting `instance` now, given the other servers and their
 * main processes. Null when it fits or anything needed cannot be read: this
 * check must never be the reason a server does not start.
 */
export async function startMemoryWarning(
	instance: ServerInstance,
	others: { instance: ServerInstance; mainPid: number | null }[]
): Promise<string | null> {
	const heapMb = configuredHeapMb(instance);
	const available = await availableMb();
	if (!heapMb || available === null) return null;
	const running: RunningUse[] = [];
	for (const other of others) {
		if (other.instance.id === instance.id || !other.mainPid) continue;
		const used = await residentMb(other.mainPid);
		const heap = (await runningHeapMb(other.mainPid)) ?? configuredHeapMb(other.instance);
		if (used === null || !heap) continue;
		running.push({ name: other.instance.name, ceilingMb: ceilingMb(heap, other.instance.limitMemoryMb), usedMb: used });
	}
	return memoryWarning({ name: instance.name, heapMb, needMb: ceilingMb(heapMb, instance.limitMemoryMb), availableMb: available, running });
}
