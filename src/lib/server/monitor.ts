import { and, eq, lt, gte, desc } from 'drizzle-orm';
import { db } from './db';
import { resourceSamples, serverInstances } from './db/schema';
import { unitState } from './systemd';
import { bus } from './events';

/**
 * CPU and memory come from the cgroup accounting systemd already does, so there
 * is no agent inside the server and no extra process. CPUUsageNSec is a running
 * total, so percentage is the delta between two polls.
 */

const SAMPLE_INTERVAL_MS = 10_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY = 60; // ticks, so roughly every ten minutes

type Previous = { cpuNsec: number; at: number };
const previous = new Map<string, Previous>();

let timer: NodeJS.Timeout | null = null;
let tick = 0;

async function sampleOnce(): Promise<void> {
	const instances = db
		.select({ id: serverInstances.id })
		.from(serverInstances)
		.all();

	const now = Date.now();

	for (const { id } of instances) {
		let state;
		try {
			state = await unitState(id);
		} catch {
			continue;
		}

		bus.publish('instance:state', { instanceId: id, active: state.active, sub: state.sub });

		if (state.active !== 'active') {
			previous.delete(id);
			continue;
		}

		const last = previous.get(id);
		previous.set(id, { cpuNsec: state.cpuUsageNsec, at: now });
		if (!last) continue;

		const elapsedNs = (now - last.at) * 1_000_000;
		const usedNs = state.cpuUsageNsec - last.cpuNsec;
		if (elapsedNs <= 0 || usedNs < 0) continue;

		// CPUUsageNSec is summed across every core the cgroup used, so a JVM
		// spread over four cores legitimately reports ~400%. That is the same
		// convention `top` uses per process. It is stored unnormalised and the
		// UI labels it against the core count rather than being clamped here,
		// which would throw away real information.
		const cpuPercent = Math.max(0, (usedNs / elapsedNs) * 100);
		const memoryBytes = state.memoryBytes;

		db.insert(resourceSamples)
			.values({ instanceId: id, timestamp: now, cpuPercent, memoryBytes })
			.run();

		bus.publish('stats:sample', { instanceId: id, cpuPercent, memoryBytes, ts: now });
	}

	tick += 1;
	if (tick % PRUNE_EVERY === 0) {
		db.delete(resourceSamples).where(lt(resourceSamples.timestamp, now - RETENTION_MS)).run();
	}
}

export function startMonitor(): void {
	if (timer) return;
	timer = setInterval(() => void sampleOnce(), SAMPLE_INTERVAL_MS);
	timer.unref?.();
	void sampleOnce();
}

export function stopMonitor(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

export type Sample = { timestamp: number; cpuPercent: number; memoryBytes: number };

export function recentSamples(instanceId: string, sinceMs = RETENTION_MS): Sample[] {
	return db
		.select({
			timestamp: resourceSamples.timestamp,
			cpuPercent: resourceSamples.cpuPercent,
			memoryBytes: resourceSamples.memoryBytes
		})
		.from(resourceSamples)
		.where(
			and(
				eq(resourceSamples.instanceId, instanceId),
				gte(resourceSamples.timestamp, Date.now() - sinceMs)
			)
		)
		.orderBy(resourceSamples.timestamp)
		.all();
}

export function latestSample(instanceId: string): Sample | undefined {
	return db
		.select({
			timestamp: resourceSamples.timestamp,
			cpuPercent: resourceSamples.cpuPercent,
			memoryBytes: resourceSamples.memoryBytes
		})
		.from(resourceSamples)
		.where(eq(resourceSamples.instanceId, instanceId))
		.orderBy(desc(resourceSamples.timestamp))
		.limit(1)
		.get();
}

/**
 * Downsample for the graph. 24h at 10s is 8640 points; the chart needs a few
 * hundred, and averaging keeps spikes visible where picking every Nth would not.
 */
export function bucketSamples(samples: Sample[], buckets = 240): Sample[] {
	if (samples.length <= buckets) return samples;
	const size = Math.ceil(samples.length / buckets);
	const out: Sample[] = [];
	for (let i = 0; i < samples.length; i += size) {
		const slice = samples.slice(i, i + size);
		out.push({
			timestamp: slice[slice.length - 1].timestamp,
			cpuPercent: slice.reduce((a, s) => a + s.cpuPercent, 0) / slice.length,
			memoryBytes: Math.round(slice.reduce((a, s) => a + s.memoryBytes, 0) / slice.length)
		});
	}
	return out;
}
