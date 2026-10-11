import fs from 'node:fs/promises';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { db } from './db';
import { packChanges, type PackChange, type ServerInstance } from './db/schema';
import { InstanceError, requireInstance, setStatus } from './instances';
import { listInstanceMods } from './mods';
import { applyPackChange, rollbackOf } from './packchange';
import { getSnapshot } from './snapshots';
import { restoreSnapshot } from './world';
import type { JavaVendor } from './javadownload';

/**
 * Undoing the last pack version change (the user's call, 2026-10-11: a pack
 * change back to the version before, with the configs put back exactly, not
 * merged). Pack mods follow the version as in any pack change; the user's own
 * mods stay as they are - also ones the change updated - and are named in the
 * form. The world can be put back from the snapshot taken before the change;
 * then the current world is kept as a snapshot. A change that moved Minecraft
 * needs that: a world that ran on the newer version does not load in the
 * older one.
 *
 * Only the newest recorded change can be rolled back, and only while the
 * server is still on the version it went to. A rollback is a recorded change
 * itself, so it can be rolled back in turn.
 */

export type RollbackInfo = {
	id: number;
	changedAt: number;
	from: { versionName: string | null; minecraft: string };
	to: { versionName: string | null };
	/** Why it cannot be rolled back; null when it can. */
	blocked: string | null;
	/** The snapshot from before the change, while it exists (retention may have deleted it). */
	snapshot: { id: string; createdAt: number; sizeBytes: number; note: string | null } | null;
	/** Going back changes Minecraft: the world has to come back too. */
	needsWorld: boolean;
	/** The user's own mods, which stay as they are. */
	keptMods: { updatedByChange: string[]; changedSince: string[] };
	/** Configs the change moved whose copies are gone from old-configs. */
	missingConfigs: string[];
};

function latestChange(instanceId: string): PackChange | null {
	return (
		db.select().from(packChanges).where(eq(packChanges.instanceId, instanceId)).orderBy(desc(packChanges.changedAt), desc(packChanges.id)).get() ??
		null
	);
}

const exists = (p: string) =>
	fs.access(p).then(
		() => true,
		() => false
	);

/** The last pack change and whether (and how) it can be rolled back; null when there is none. */
export async function rollbackInfo(instance: ServerInstance): Promise<RollbackInfo | null> {
	const record = latestChange(instance.id);
	if (!record || record.rolledBackAt) return null;

	const stillOnIt =
		record.toVersionId !== null
			? instance.packVersionId === record.toVersionId
			: instance.packVersionId === null && instance.packVersionName === record.toVersionName;
	const snapshot = record.snapshotId ? await getSnapshot(instance.path, record.snapshotId) : null;
	const fullSnapshot = snapshot && !snapshot.partial ? snapshot : null;
	const needsWorld = record.fromMinecraft !== instance.minecraftVersion;

	let blocked: string | null = null;
	if (!stillOnIt) {
		blocked = 'The pack has changed since in a way MineShell did not record, so it cannot tell what to go back to.';
	} else if (!record.fromVersionId) {
		blocked =
			'The version before was an uploaded file, which MineShell does not keep. Upload that file again under "Pack version" to go back to it (your configs are then merged, not put back).';
	} else if (!instance.packSource || !instance.packProjectId) {
		blocked = 'This server has no pack project to fetch the earlier version from.';
	} else if (needsWorld && !fullSnapshot) {
		blocked = `That change moved Minecraft from ${record.fromMinecraft} to ${instance.minecraftVersion}. A world that ran on the newer version does not load in the older one, and the snapshot from before the change ${record.snapshotId ? 'is gone' : 'was not taken'}.`;
	}

	const updatedByChange = (JSON.parse(record.updatedMods) as { fileName: string; name: string }[]).map((m) => m.name);
	let changedSince: string[] = [];
	if (record.userModsAfter) {
		const after = new Set(JSON.parse(record.userModsAfter) as string[]);
		const base = (n: string) => n.replace(/\.disabled$/, '');
		changedSince = (await listInstanceMods(instance).catch(() => []))
			.filter((r) => !r.fromPack && !after.has(base(r.fileName)))
			.map((r) => r.name);
	}

	const missingConfigs: string[] = [];
	for (const name of JSON.parse(record.configsMoved) as string[]) {
		if (!record.oldConfigs || !(await exists(path.join(instance.path, record.oldConfigs, name)))) missingConfigs.push(name);
	}

	return {
		id: record.id,
		changedAt: record.changedAt,
		from: { versionName: record.fromVersionName, minecraft: record.fromMinecraft },
		to: { versionName: record.toVersionName },
		blocked,
		snapshot: fullSnapshot
			? { id: fullSnapshot.id, createdAt: fullSnapshot.createdAt, sizeBytes: fullSnapshot.sizeBytes, note: fullSnapshot.note ?? null }
			: null,
		needsWorld,
		keptMods: { updatedByChange, changedSince },
		missingConfigs
	};
}

/**
 * Starts the rollback of the last pack change; returns the task id. With
 * `restoreWorld` the world is restored from the change's snapshot once the
 * pack is back (its own task, which keeps the current world as a snapshot);
 * without it, `snapshot` copies the world first as for any pack change.
 */
export async function rollbackPackChange(
	instance: ServerInstance,
	opts: { restoreWorld: boolean; snapshot: boolean; downloadJava?: JavaVendor }
): Promise<string> {
	const info = await rollbackInfo(instance);
	if (!info) throw new InstanceError('There is no pack change to roll back.');
	if (info.blocked) throw new InstanceError(info.blocked);
	if (info.needsWorld && !opts.restoreWorld) {
		throw new InstanceError(`Going back to Minecraft ${info.from.minecraft} needs the world from before the change too.`);
	}
	if (opts.restoreWorld && !info.snapshot) throw new InstanceError('The snapshot from before that change is gone.');
	const record = db.select().from(packChanges).where(eq(packChanges.id, info.id)).get()!;
	const snapshotId = info.snapshot?.id ?? null;

	return applyPackChange(instance, record.fromVersionId!, {
		updateMods: [],
		confirmMinecraftChange: true,
		// Restoring the world keeps the current one as a snapshot anyway (a rename, no copy).
		snapshot: opts.restoreWorld ? false : opts.snapshot,
		downloadJava: opts.downloadJava,
		rollback: rollbackOf(record),
		then:
			opts.restoreWorld && snapshotId
				? async (task) => {
						try {
							await restoreSnapshot(requireInstance(instance.id), snapshotId, { snapshot: true });
							task.log(`Restoring the world from ${snapshotId}, in its own task; the current world is kept as a snapshot.`);
						} catch (err) {
							const message = err instanceof Error ? err.message : 'unknown error';
							task.log(`Restoring the world failed: ${message}`);
							setStatus(instance.id, 'ready', `The pack was rolled back, but restoring the world from ${snapshotId} failed: ${message} Restore it from the World tab.`);
						}
					}
				: undefined
	});
}
