import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';

/**
 * Named areas every prune of their dimension skips (World > Prune chunks): a
 * base, a town, a build barely visited since it was finished. Protecting on
 * the map is per prune; an area is the same chunks kept for good. Saved from
 * the chunks protected on the map, per server and dimension (its key, as the
 * page names it: `world/region`, `world/DIM-1`), in one settings row per server.
 */

/** A refusal to show as it is. */
export class PruneAreaError extends Error {}

export type PruneArea = { id: string; name: string; dimension: string; chunks: string[] };

const KEY = (instanceId: string) => `prune.areas:${instanceId}`;
export const MAX_AREA_NAME = 60;
/** Chunks in all of a server's areas: a map's protection, not a whole world. */
export const MAX_AREA_CHUNKS = 200_000;

export function listPruneAreas(instanceId: string, dimension?: string): PruneArea[] {
	const row = db.select().from(settings).where(eq(settings.key, KEY(instanceId))).get();
	let areas: PruneArea[] = [];
	try {
		areas = row ? (JSON.parse(row.value) as PruneArea[]) : [];
	} catch {
		/* unreadable: none */
	}
	return dimension === undefined ? areas : areas.filter((a) => a.dimension === dimension);
}

function write(instanceId: string, areas: PruneArea[]): void {
	if (!areas.length) {
		db.delete(settings).where(eq(settings.key, KEY(instanceId))).run();
		return;
	}
	const value = JSON.stringify(areas);
	db.insert(settings).values({ key: KEY(instanceId), value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/** Saves `chunks` ("x,z" each) as a named area of `dimension`; a name used there already is refused. */
export function savePruneArea(instanceId: string, dimension: string, name: string, chunks: Set<string>): PruneArea {
	const clean = name.trim().slice(0, MAX_AREA_NAME);
	if (!clean) throw new PruneAreaError('Give the area a name.');
	if (!chunks.size) throw new PruneAreaError('Protect the chunks on the map first, then save them as an area.');
	const areas = listPruneAreas(instanceId);
	if (areas.some((a) => a.dimension === dimension && a.name.toLowerCase() === clean.toLowerCase())) throw new PruneAreaError(`There is an area called ${clean} already.`);
	if (areas.reduce((n, a) => n + a.chunks.length, 0) + chunks.size > MAX_AREA_CHUNKS) {
		throw new PruneAreaError(`That is more than the ${MAX_AREA_CHUNKS.toLocaleString('en')} chunks areas may hold together.`);
	}
	const area: PruneArea = { id: randomBytes(6).toString('hex'), name: clean, dimension, chunks: [...chunks].sort() };
	write(instanceId, [...areas, area]);
	return area;
}

export function deletePruneArea(instanceId: string, id: string): boolean {
	const areas = listPruneAreas(instanceId);
	const left = areas.filter((a) => a.id !== id);
	if (left.length === areas.length) return false;
	write(instanceId, left);
	return true;
}

/** Every chunk the areas of `dimension` protect. */
export function areaChunks(instanceId: string, dimension: string): Set<string> {
	return new Set(listPruneAreas(instanceId, dimension).flatMap((a) => a.chunks));
}

export function deletePruneAreas(instanceId: string): void {
	write(instanceId, []);
}
