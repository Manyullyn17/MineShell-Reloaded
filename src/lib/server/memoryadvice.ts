import os from 'node:os';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { heapSamplesSince, HEAP_RETENTION_MS, type HeapSample } from './heap';
import { playedIntervals } from './history';
import { searchJournal } from './journal';
import { MIN_HOURS, MIN_PLAYED_HOURS, type MemoryAdvice } from '#lib/shared/memoryadvice.js';

export type { MemoryAdvice };

/**
 * Advice on a server's maximum memory (-Xmx), never applied by itself.
 *
 * What a server needs is its heap after garbage collection, not its peak:
 * G1 lets the heap fill before collecting, so a healthy server touches most of
 * its maximum. Samples come once a minute; the lowest of an hour is close to
 * what survives a collection, and the highest of those lows (the busiest
 * hour) is taken as what it needs. Java wants two to three times that.
 *
 * An empty server holds far less than one with players on it, so only hours
 * with someone online can say it has more than it needs; idle hours still
 * count towards it being short.
 */

const HOUR = 60 * 60 * 1000;
const GB = 1024;
/** An hour counts with at least this many samples (of 60). */
const SAMPLES_PER_HOUR = 20;
/** An OutOfMemoryError this recent, after the last change to the memory, asks for more. */
const OOM_WINDOW_MS = 14 * 24 * HOUR;


const roundUpGb = (mb: number) => Math.ceil(mb / GB) * GB;
const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** The heap a server needs, from its samples: the highest hourly low. Null with too few hours. */
export function neededHeap(samples: HeapSample[]): { neededMb: number; heapMaxMb: number; hours: number } | null {
	const hours = new Map<number, HeapSample[]>();
	for (const s of samples) {
		const hour = Math.floor(s.timestamp / HOUR);
		const list = hours.get(hour);
		if (list) list.push(s);
		else hours.set(hour, [s]);
	}
	const lows = [...hours.values()].filter((h) => h.length >= SAMPLES_PER_HOUR).map((h) => Math.min(...h.map((s) => s.usedBytes)));
	if (!samples.length) return null;
	const heapMaxMb = toMb(samples[samples.length - 1].maxBytes);
	return lows.length ? { neededMb: toMb(Math.max(...lows)), heapMaxMb, hours: lows.length } : { neededMb: 0, heapMaxMb, hours: 0 };
}

/**
 * The advice itself. `currentMb` is the setting (which a restart applies);
 * the samples carry the maximum the running JVM has. Suggestions are whole
 * gigabytes and leave the machine 2 GB.
 */
export function adviseMemory(input: {
	samples: HeapSample[];
	/** When players were online, as [start, end] stretches. */
	played: [number, number][];
	currentMb: number;
	oomAt: number | null;
	totalRamMb: number;
}): MemoryAdvice {
	const { currentMb, oomAt, totalRamMb } = input;
	const heap = neededHeap(input.samples);
	const hours = heap?.hours ?? 0;
	const busy = neededHeap(input.samples.filter((s) => input.played.some(([start, end]) => s.timestamp >= start && s.timestamp <= end)));
	const playedHours = busy?.hours ?? 0;
	const room = totalRamMb - 2 * GB;
	const more = (want: number) => {
		const suggested = Math.min(roundUpGb(want), Math.floor(room / GB) * GB);
		return suggested > currentMb ? suggested : null;
	};
	if (oomAt !== null) {
		const needed = heap && hours ? heap.neededMb : null;
		return { kind: 'more', reason: 'out-of-memory', currentMb, suggestedMb: more(Math.max(currentMb * 1.5, (needed ?? 0) * 3)), neededMb: needed, oomAt, hours };
	}
	if (!heap || hours < MIN_HOURS) return { kind: 'unknown', currentMb, hours, playedHours };
	const { heapMaxMb } = heap;
	const neededMb = Math.max(heap.neededMb, busy?.neededMb ?? 0);
	if (neededMb > heapMaxMb * 0.7) {
		return { kind: 'more', reason: 'full', currentMb, suggestedMb: more(Math.max(heapMaxMb * 1.5, neededMb * 3)), neededMb, oomAt: null, hours };
	}
	if (playedHours < MIN_PLAYED_HOURS) return { kind: 'unknown', currentMb, hours, playedHours };
	const suggested = Math.max(roundUpGb(neededMb * 3), 2 * GB);
	if (neededMb * 5 < heapMaxMb && currentMb - suggested >= 2 * GB) return { kind: 'less', currentMb, suggestedMb: suggested, neededMb, hours };
	return { kind: 'ok', currentMb, neededMb, hours };
}

const CHANGED = (id: string) => `memory.changedAt:${id}`;

/** Called when the maximum memory is saved: older out-of-memory crashes no longer count. */
export function markMemoryChanged(instanceId: string): void {
	const value = String(Date.now());
	db.insert(settings).values({ key: CHANGED(instanceId), value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

export function deleteMemorySettings(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, CHANGED(instanceId))).run();
}

function memoryChangedAt(instanceId: string): number {
	const row = db.select().from(settings).where(eq(settings.key, CHANGED(instanceId))).get();
	return Number(row?.value ?? 0) || 0;
}

/** The journal search takes half a second on a big pack: kept for a few minutes. */
const oomCache = new Map<string, { at: number; since: number; oomAt: number | null }>();
const OOM_CACHE_MS = 5 * 60 * 1000;

async function lastOutOfMemory(instance: ServerInstance): Promise<number | null> {
	const since = Math.max(instance.createdAt, Date.now() - OOM_WINDOW_MS, memoryChangedAt(instance.id));
	const hit = oomCache.get(instance.id);
	if (hit && hit.since === since && Date.now() - hit.at < OOM_CACHE_MS) return hit.oomAt;
	const found = await searchJournal(instance.id, 'java.lang.OutOfMemoryError', since, 1);
	const oomAt = found.at(-1)?.at ?? null;
	oomCache.set(instance.id, { at: Date.now(), since, oomAt });
	return oomAt;
}

export async function memoryAdvice(instance: ServerInstance): Promise<MemoryAdvice> {
	const since = Math.max(Date.now() - HEAP_RETENTION_MS, memoryChangedAt(instance.id));
	return adviseMemory({
		samples: heapSamplesSince(instance.id, since),
		played: playedIntervals(instance.id, since),
		currentMb: instance.memoryMaxMb ?? 4096,
		oomAt: await lastOutOfMemory(instance).catch(() => null),
		totalRamMb: Math.floor(os.totalmem() / 1024 / 1024)
	});
}
