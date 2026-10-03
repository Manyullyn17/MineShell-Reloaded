import type { ServerInstance } from './db/schema';
import type { TaskHandle } from './tasks';
import { indexMods } from './crashdiag';
import { hashFile } from './download';
import { safeJoin } from './files';
import {
	DISABLED_SUFFIX,
	listInstanceMods,
	markClientOnly,
	modsDir,
	setModEnabled
} from './mods';
import { projectsByIds, versionsFromHashes } from './mods/modrinth';

/**
 * Client-only mods in a server install. Packs bring them in because their
 * metadata says nothing (CurseForge manifests have no client/server field)
 * or says it wrongly; on a server they at best do nothing and at worst
 * crash it on start (a Swing window with no display, client classes).
 *
 * A jar counts as client-only when Modrinth lists its project as
 * `client_only` (looked up by hash, so it works for CurseForge-tracked and
 * manual jars too), when its mod record is already flagged, or when the jar
 * itself declares a client environment (Fabric/Quilt).
 *
 * Only jars an install just added are looked at, so a mod someone turned
 * back on stays on. One that an enabled mod declares as required is kept:
 * disabling it would only trade one crash for another.
 */

/** Why an already-flagged mod is client-only; other sources' flags may come from any check. */
const FLAGGED_BY: Record<string, string> = { modrinth: 'Modrinth lists it as client-only' };

export type ClientOnlyResult = {
	/** File names as they were (enabled), now renamed to .disabled. */
	disabled: { fileName: string; name: string; reason: string }[];
	/** Client-only, but required by a mod that stays enabled. */
	kept: { fileName: string; name: string; neededBy: string[] }[];
};

export async function disableClientOnlyMods(
	instance: ServerInstance,
	fileNames: string[],
	task?: TaskHandle
): Promise<ClientOnlyResult> {
	const result: ClientOnlyResult = { disabled: [], kept: [] };
	const wanted = new Set(fileNames);
	const rows = (await listInstanceMods(instance)).filter((r) => r.enabled && !r.missing && wanted.has(r.fileName));
	if (rows.length === 0) return result;

	const jars = await indexMods(modsDir(instance.path));
	const jarByFile = new Map(jars.map((j) => [j.fileName, j]));

	const reasons = new Map<string, string>();
	for (const row of rows) {
		if (row.clientOnly) reasons.set(row.fileName, FLAGGED_BY[row.source] ?? 'known to be client-only');
		else if (jarByFile.get(row.fileName)?.clientOnly) reasons.set(row.fileName, 'the mod declares itself client-only');
	}

	// Modrinth's environment, by hash, for everything not already decided.
	const hashes = new Map<string, string>();
	for (const row of rows) {
		if (reasons.has(row.fileName)) continue;
		const hash = await hashFile(safeJoin(modsDir(instance.path), row.fileName), 'sha512').catch(() => null);
		if (hash) hashes.set(hash, row.fileName);
	}
	const versions = await versionsFromHashes([...hashes.keys()]);
	const projects = await projectsByIds([...versions.values()].map((v) => v.projectId));
	for (const [hash, version] of versions) {
		if (projects.get(version.projectId)?.clientOnly) {
			reasons.set(hashes.get(hash)!, 'Modrinth lists it as client-only');
		}
	}
	if (reasons.size === 0) return result;

	// Keep any that a mod staying enabled requires - repeated, since keeping
	// one can make what it requires necessary too.
	const neededBy = new Map<string, string[]>();
	for (let changed = true; changed; ) {
		changed = false;
		const staying = jars.filter((j) => j.enabled && (!reasons.has(j.fileName) || neededBy.has(j.fileName)));
		for (const fileName of reasons.keys()) {
			if (neededBy.has(fileName)) continue;
			const ids = jarByFile.get(fileName)?.ids ?? [];
			const dependents = staying.filter((j) => j.fileName !== fileName && j.requires.some((id) => ids.includes(id)));
			if (dependents.length) {
				neededBy.set(fileName, dependents.map((j) => j.names[0] ?? j.fileName));
				changed = true;
			}
		}
	}

	for (const row of rows) {
		const reason = reasons.get(row.fileName);
		if (!reason) continue;
		markClientOnly(instance, row.fileName);
		const by = neededBy.get(row.fileName);
		if (by) {
			result.kept.push({ fileName: row.fileName, name: row.name, neededBy: by });
			task?.log(`Kept client-only ${row.name}: ${by.join(', ')} require${by.length === 1 ? 's' : ''} it.`);
			continue;
		}
		await setModEnabled(instance, row.fileName, false);
		result.disabled.push({ fileName: row.fileName, name: row.name, reason });
		task?.log(`Disabled ${row.name} (${row.fileName}${DISABLED_SUFFIX}): ${reason}.`);
	}
	return result;
}

/** One status line for an install's summary, or null when nothing happened. */
export function describeClientOnlyResult(result: ClientOnlyResult): string | null {
	if (result.disabled.length === 0) return null;
	const names = result.disabled.map((d) => d.name).join(', ');
	return (
		`Disabled ${result.disabled.length} client-only mod${result.disabled.length === 1 ? '' : 's'} ` +
		`(${names}); they do nothing on a server or crash it. Re-enable one on the Mods page if the server needs it.`
	);
}
