import fs from 'node:fs/promises';
import type { ServerInstance } from './db/schema';
import { destinations, notify } from './notifications';
import { freeSpace, getSnapshotPolicy } from './snapshots';
import { formatBytes } from '#lib/shared/format.js';

/**
 * A warning when a disk holding servers runs low: a full disk is what damages
 * worlds (a save cut off half-way). Checked on every scheduler tick. The line
 * is the largest "Keep free on the disk" of the servers on that disk, where
 * their snapshots stop, or FALLBACK_BYTES when every one has it off.
 *
 * One message per disk and destination, not per server (they mostly share
 * one): each destination any of its servers sends disk warnings to hears it
 * once, under the first of those servers, naming the others. Sent when the disk
 * drops below the line, and again only after it was back above it by MARGIN,
 * so free space hovering at the line is not a message every minute. Kept in
 * memory: a restart of MineShell while the disk is low says it once more.
 */
const FALLBACK_BYTES = 2 * 1024 ** 3;
const MARGIN = 1.1;

const low = new Set<number>();

export async function checkDiskSpace(instances: ServerInstance[], now = Date.now()): Promise<void> {
	const disks = new Map<number, ServerInstance[]>();
	for (const instance of instances) {
		const stat = await fs.stat(instance.path).catch(() => null);
		if (!stat) continue;
		disks.set(stat.dev, [...(disks.get(stat.dev) ?? []), instance]);
	}
	for (const [dev, servers] of disks) {
		const free = await freeSpace(servers[0].path);
		if (free === null) continue;
		const line = Math.max(0, ...servers.map((s) => getSnapshotPolicy(s.id).minFreeMb * 1024 * 1024)) || FALLBACK_BYTES;
		if (free >= line * (low.has(dev) ? MARGIN : 1)) {
			low.delete(dev);
			continue;
		}
		if (low.has(dev)) continue;
		low.add(dev);
		// Not only the first server's: one with a destination of its own (and not the
		// global one) heard of a shared disk only when the message went under it.
		const routes = new Map<ServerInstance, string[]>();
		const taken = new Set<string>();
		for (const server of servers) {
			const keys = destinations(server.id, 'disk').map((d) => d.key).filter((key) => !taken.has(key));
			for (const key of keys) taken.add(key);
			if (keys.length) routes.set(server, keys);
		}
		for (const [to, keys] of routes) {
			const others = servers.filter((s) => s !== to).map((s) => s.name);
			void notify(
				{
					kind: 'disk',
					instance: { id: to.id, name: to.name },
					title: 'Disk running low',
					message:
						`Only ${formatBytes(free)} is free on the disk with ${others.length ? `this server and ${others.join(', ')}` : 'this server'}, below the ${formatBytes(line)} to keep free. ` +
						'Snapshots stop there, and a world saved onto a full disk can be damaged. The Files tab\'s disk usage shows what takes the space.',
					at: now
				},
				now,
				keys
			);
		}
	}
}

/** Forgets which disks were low, for tests. */
export function resetDiskSpace(): void {
	low.clear();
}
