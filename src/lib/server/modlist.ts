import { inArray } from 'drizzle-orm';
import { indexMods } from './crashdiag.js';
import { db } from './db/index.js';
import { mods as modsTable, type ServerInstance } from './db/schema.js';
import { listInstanceMods, modsDir } from './mods/index.js';
import type { ModListEntry } from '#lib/shared/modlist.js';

/**
 * The mods in the server's folder, for the mod list export. Name and link come
 * from where MineShell installed it from; version and authors from the jar
 * itself, which knows all of them (Modrinth's project carries no author, and
 * CurseForge's file name stands in for a version), falling back to the record.
 * A jar MineShell has no record of, or recorded as uploaded (named after its
 * file), is named by its metadata.
 */
export async function modListEntries(instance: ServerInstance): Promise<ModListEntry[]> {
	const rows = (await listInstanceMods(instance)).filter((r) => !r.missing);
	const jars = new Map((await indexMods(modsDir(instance.path))).map((j) => [j.fileName, j]));
	const ids = rows.flatMap((r) => (r.id === null ? [] : [r.id]));
	const authors = new Map(
		ids.length
			? db.select({ id: modsTable.id, author: modsTable.author }).from(modsTable).where(inArray(modsTable.id, ids)).all().map((m) => [m.id, m.author])
			: []
	);
	const entries = rows.map((r): ModListEntry => {
		const jar = jars.get(r.fileName);
		const recorded = r.id === null ? null : (authors.get(r.id) ?? null);
		return {
			name: ((r.untracked || r.source === 'manual') && jar?.names[0]) || r.name,
			version: jar?.version ?? r.version,
			authors: jar?.authors.length ? jar.authors : recorded ? [recorded] : [],
			url: r.projectUrl,
			file: r.fileName,
			enabled: r.enabled,
			clientOnly: r.clientOnly || !!jar?.clientOnly
		};
	});
	return entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}
