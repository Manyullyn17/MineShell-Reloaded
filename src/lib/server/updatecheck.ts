import { eq } from 'drizzle-orm';
import { db } from './db';
import { serverInstances, updateNotices, type ServerInstance, type UpdateNotice } from './db/schema';
import { getProvider } from './mods/index';
import { LOADERS, pickerLoaderVersions, type ModloaderId } from './modloaders';
import { notify } from './notifications';
import { UPDATE_CHANNELS, type UpdateChannel, type UpdateKind } from '#lib/shared/updatecheck.js';

/**
 * Periodic checks for something newer to install: the next pack version on a
 * pack server, the next loader build on a server set up from a loader (a
 * pack's author picks its loader, so pack servers are not offered one). The
 * scheduler runs them (`runDueUpdateChecks`); the result is one row in
 * update_notices, shown on the overview until it is installed or skipped.
 */

const RANK: Record<UpdateChannel, number> = { release: 0, beta: 1, alpha: 2 };

/** A version's channel is offered under the server's setting (unknown channels count as releases). */
export function channelAllowed(channel: string, setting: string): boolean {
	const wanted = UPDATE_CHANNELS.includes(setting as UpdateChannel) ? (setting as UpdateChannel) : 'release';
	return (RANK[channel as UpdateChannel] ?? 0) <= RANK[wanted];
}

/** What a server is checked for, if anything. An uploaded pack has no project to list versions from. */
export function updateKind(instance: Pick<ServerInstance, 'packSource' | 'packProjectId' | 'modloader'>): UpdateKind | null {
	if (instance.packSource) return instance.packProjectId ? 'pack' : null;
	return instance.modloader === 'vanilla' ? null : 'loader';
}

export type FoundUpdate = { kind: UpdateKind; fromVersion: string; versionId: string; label: string; channel: string };

type ListedVersion = { id: string; name: string; versionNumber: string; channel: string; datePublished: string | null };

/**
 * The newest pack version published after the installed one, on an allowed
 * channel. By date where both have one (the mirror's can lack it), else by
 * the provider's order, newest first. Null when the installed version is not
 * in the list: nothing to compare with.
 */
export function pickPackUpdate(versions: ListedVersion[], currentId: string, setting: string): Omit<FoundUpdate, 'kind' | 'fromVersion'> | null {
	const at = versions.findIndex((v) => v.id === currentId);
	if (at < 0) return null;
	const date = (v: ListedVersion) => Date.parse(v.datePublished ?? '');
	const since = date(versions[at]);
	const newer = versions.filter((v, i) => {
		if (v.id === currentId || !channelAllowed(v.channel, setting)) return false;
		return Number.isFinite(since) && Number.isFinite(date(v)) ? date(v) > since : i < at;
	});
	if (!newer.length) return null;
	const best = newer.every((v) => Number.isFinite(date(v))) ? newer.reduce((a, b) => (date(b) > date(a) ? b : a)) : newer[0];
	return { versionId: best.id, label: best.versionNumber || best.name, channel: best.channel };
}

/** A loader build's channel from its name: 0.16.0-beta.1, 1.21.1-pre2, 26.1.0-rc.1. */
export function loaderChannel(version: string): UpdateChannel {
	if (/alpha/i.test(version)) return 'alpha';
	if (/beta|[-.+](rc|pre)\d*\b/i.test(version)) return 'beta';
	return 'release';
}

/**
 * The newest loader build above the installed one, from a list newest first.
 * Cleanroom names every build alpha, and its 0.6 line swapped Mixin for
 * CleanMix, which breaks mods: it is offered builds of its own line only.
 */
export function pickLoaderUpdate(loader: string, versions: string[], installed: string, setting: string): string | null {
	const at = versions.indexOf(installed);
	if (at <= 0) return null;
	const line = installed.match(/^(\d+\.\d+)\./)?.[1];
	for (const version of versions.slice(0, at)) {
		if (loader === 'cleanroom') {
			if (line && version.startsWith(`${line}.`)) return version;
		} else if (channelAllowed(loaderChannel(version), setting)) return version;
	}
	return null;
}

/** Asks the pack's provider or the loader's version list. */
export async function findUpdate(instance: ServerInstance): Promise<FoundUpdate | null> {
	const kind = updateKind(instance);
	if (kind === 'pack' && instance.packSource && instance.packProjectId && instance.packVersionId) {
		const versions = await getProvider(instance.packSource).listVersions(instance.packProjectId, {});
		const found = pickPackUpdate(versions, instance.packVersionId, instance.updateChannel);
		return found && { kind, fromVersion: instance.packVersionId, ...found };
	}
	if (kind === 'loader' && instance.modloaderVersion) {
		const versions = await pickerLoaderVersions(instance.modloader, instance.minecraftVersion);
		const version = pickLoaderUpdate(instance.modloader, versions, instance.modloaderVersion, instance.updateChannel);
		return version ? { kind, fromVersion: instance.modloaderVersion, versionId: version, label: version, channel: loaderChannel(version) } : null;
	}
	return null;
}

/** After a failed lookup (offline, the provider down), the next try comes this soon. */
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

/**
 * Checks one server and keeps the result. The same version found again keeps
 * its skipped flag; a newer one replaces it, shown again.
 */
export async function checkForUpdates(instance: ServerInstance, find = findUpdate): Promise<{ ok: true; found: FoundUpdate | null } | { ok: false; error: string }> {
	let found: FoundUpdate | null;
	try {
		found = await find(instance);
	} catch (err) {
		const due = instance.updateCheckHours * 3600_000;
		db.update(serverInstances)
			.set({ updateCheckedAt: Date.now() - Math.max(0, due - RETRY_AFTER_FAILURE_MS) })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: false, error: err instanceof Error ? err.message : 'The lookup failed.' };
	}
	db.transaction((tx) => {
		const existing = tx.select().from(updateNotices).where(eq(updateNotices.instanceId, instance.id)).get();
		if (!found) {
			tx.delete(updateNotices).where(eq(updateNotices.instanceId, instance.id)).run();
		} else if (existing && existing.kind === found.kind && existing.versionId === found.versionId) {
			tx.update(updateNotices).set({ fromVersion: found.fromVersion }).where(eq(updateNotices.instanceId, instance.id)).run();
		} else {
			const row = { ...found, instanceId: instance.id, foundAt: Date.now(), skipped: false };
			tx.insert(updateNotices).values(row).onConflictDoUpdate({ target: updateNotices.instanceId, set: row }).run();
			const what = found.kind === 'pack' ? (instance.packName ?? 'The pack') : (LOADERS[instance.modloader as ModloaderId]?.label ?? instance.modloader);
			const runs = found.kind === 'pack' ? (instance.packVersionName ?? 'an older version') : found.fromVersion;
			void notify({
				kind: 'update',
				instance: { id: instance.id, name: instance.name },
				title: 'Update available',
				message: `${what} ${found.label}${found.channel !== 'release' ? ` (${found.channel})` : ''} is out; the server runs ${runs}. Its overview in MineShell has the button to review and install it.`,
				at: Date.now()
			});
		}
		tx.update(serverInstances).set({ updateCheckedAt: Date.now() }).where(eq(serverInstances.id, instance.id)).run();
	});
	return { ok: true, found };
}

/** The version a server runs, in the terms its notice was found from. */
function installedVersion(instance: ServerInstance, kind: string): string | null {
	return kind === 'pack' ? instance.packVersionId : instance.modloaderVersion;
}

/** The update to show for a server: found from what it runs now, not skipped, and still wanted. */
export function currentNotice(instance: ServerInstance): UpdateNotice | null {
	if (!instance.updateCheck) return null;
	const row = db.select().from(updateNotices).where(eq(updateNotices.instanceId, instance.id)).get();
	if (!row || row.skipped || row.kind !== updateKind(instance) || row.fromVersion !== installedVersion(instance, row.kind)) return null;
	return row;
}

/** Hides this version's notice; a newer one shows again. */
export function skipNotice(instanceId: string, versionId: string): boolean {
	const row = db.select().from(updateNotices).where(eq(updateNotices.instanceId, instanceId)).get();
	if (!row || row.versionId !== versionId) return false;
	db.update(updateNotices).set({ skipped: true }).where(eq(updateNotices.instanceId, instanceId)).run();
	return true;
}

/** The server's check is on, it has something to check, and its interval has passed. */
export function checkDue(instance: ServerInstance, now = Date.now()): boolean {
	if (!instance.updateCheck || instance.status !== 'ready' || !updateKind(instance)) return false;
	return instance.updateCheckedAt === null || now - instance.updateCheckedAt >= instance.updateCheckHours * 3600_000;
}

let checking = false;

/** From the scheduler's tick: every due server, one after another; a tick while that runs does nothing. */
export async function runDueUpdateChecks(now = Date.now()): Promise<void> {
	if (checking) return;
	checking = true;
	try {
		for (const instance of db.select().from(serverInstances).all()) {
			if (checkDue(instance, now)) await checkForUpdates(instance);
		}
	} finally {
		checking = false;
	}
}
