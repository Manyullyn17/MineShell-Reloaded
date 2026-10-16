import fs from 'node:fs/promises';
import path from 'node:path';
import { cpus, totalmem } from 'node:os';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';
import { systemdUnitDir } from './config';
import { SERVER_SLICE, systemctl, templateUnitInstalled } from './systemd';

/**
 * One cap on all servers together, set on the slice they share
 * (unit-template.js, `Slice=`). Memory is a soft cap, `MemoryHigh=`: past it
 * the kernel reclaims and throttles inside the slice instead of killing a
 * server (user's call, 2026-10-05). It drops page cache first, then swaps or
 * stalls the JVMs, which shows as lag on every server; it cannot shrink a heap
 * Java already holds. CPU is `CPUQuota=`, a throttle anyway. Like the
 * per-server limits, a daemon-reload applies it to running servers at once.
 */

export type ServerCap = { memoryMb: number | null; cpuPercent: number | null };

const KEY = 'servers.cap';
export const MIN_CAP_MEMORY_MB = 1024;

export function getServerCap(): ServerCap {
	const raw = db.select().from(settings).where(eq(settings.key, KEY)).get()?.value;
	try {
		const parsed = raw ? (JSON.parse(raw) as Partial<ServerCap>) : {};
		const pick = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
		return { memoryMb: pick(parsed.memoryMb), cpuPercent: pick(parsed.cpuPercent) };
	} catch {
		return { memoryMb: null, cpuPercent: null };
	}
}

export function totalMemoryMb(): number {
	return Math.floor(totalmem() / 1024 ** 2);
}

export function maxCpuPercent(): number {
	return (cpus().length || 1) * 100;
}

/** Why a cap cannot be saved, or null. */
export function capProblem(cap: ServerCap): string | null {
	const total = totalMemoryMb();
	if (cap.memoryMb !== null && (!Number.isInteger(cap.memoryMb) || cap.memoryMb < MIN_CAP_MEMORY_MB || cap.memoryMb > total)) {
		return `The memory cap is between ${MIN_CAP_MEMORY_MB} and ${total} MB (this machine's memory), or blank for none.`;
	}
	const maxCpu = maxCpuPercent();
	if (cap.cpuPercent !== null && (!Number.isInteger(cap.cpuPercent) || cap.cpuPercent < 10 || cap.cpuPercent > maxCpu)) {
		return `The CPU cap is between 10 and ${maxCpu} percent, or blank for none.`;
	}
	return null;
}

export function saveServerCap(cap: ServerCap): void {
	const value = JSON.stringify(cap);
	db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/** The slice unit for a cap, or null when there is none to set. */
export function renderSliceUnit(cap: ServerCap): string | null {
	const lines: string[] = [];
	if (cap.memoryMb) lines.push(`MemoryHigh=${cap.memoryMb}M`);
	if (cap.cpuPercent) lines.push(`CPUQuota=${cap.cpuPercent}%`);
	if (!lines.length) return null;
	return `# Managed by MineShell. Set under MineShell settings > System.
[Unit]
Description=Minecraft servers managed by MineShell

[Slice]
${lines.join('\n')}
`;
}

export function sliceUnitFile(): string {
	return path.join(systemdUnitDir(), SERVER_SLICE);
}

/**
 * Writes the slice unit for the saved cap, or removes it when there is none
 * (systemd then makes the slice by itself, without limits). Only a file
 * MineShell wrote is replaced or removed. Without the template unit there are
 * no servers to cap; installing it applies the cap.
 */
export async function applyServerCap(cap: ServerCap = getServerCap()): Promise<void> {
	if (!(await templateUnitInstalled())) return;
	const file = sliceUnitFile();
	const body = renderSliceUnit(cap);
	const current = await fs.readFile(file, 'utf8').catch(() => null);
	if (current === body) return;
	if (current !== null && !current.startsWith('# Managed by MineShell')) {
		throw new Error(`${file} was not written by MineShell; remove it to set the cap here.`);
	}
	if (body) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, body, 'utf8');
	} else if (current === null) {
		return;
	} else {
		await fs.rm(file, { force: true });
	}
	const reload = await systemctl('daemon-reload');
	if (reload.code !== 0) throw new Error(reload.stderr.trim() || 'daemon-reload failed');
}

/** Whether a running unit's cgroup is inside the servers' slice. */
export function inServerSlice(controlGroup: string): boolean {
	return controlGroup.split('/').includes(SERVER_SLICE);
}

/**
 * The warning for starting a server that can take `needMb` while the running
 * ones can take theirs, when together that is past the memory cap; null when
 * it fits. Nothing is killed at the cap, but every server slows down.
 */
export function capWarning(input: { name: string; needMb: number; capMb: number; running: { name: string; ceilingMb: number }[] }): string | null {
	const runningMb = input.running.reduce((sum, r) => sum + r.ceilingMb, 0);
	if (input.needMb + runningMb <= input.capMb) return null;
	const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
	return (
		`${input.name} can take up to ${gb(input.needMb)}` +
		(input.running.length ? ` and ${input.running.map((r) => r.name).join(', ')} up to ${gb(runningMb)}` : '') +
		`, past the ${gb(input.capMb)} cap on all servers together. Past it the system holds every server back, which shows as lag.`
	);
}
