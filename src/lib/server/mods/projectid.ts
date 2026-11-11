import type { ProjectKind } from './types';

/**
 * A project's id typed into a search box. Each catalog shows it on the project's page
 * (CurseForge's "Project ID", Modrinth's under the project's details, FTB's in the address), and
 * a lookup by it works when the catalog's own search does not find the project: since November
 * 2026 CurseForge's search and slug lookup no longer match MeatballCraft, for anyone (the mirror
 * passes CurseForge's search on), while /mods/411966 still answers.
 */
export function projectIdIn(source: string, term: string): string | null {
	const text = term.trim();
	if (source === 'curseforge' || source === 'ftb') return /^\d{1,10}$/.test(text) ? text : null;
	// Modrinth's ids are eight letters and digits; one that is also a slug ("computer") finds that.
	if (source === 'modrinth') return /^[A-Za-z0-9]{8}$/.test(text) ? text : null;
	return null;
}

/**
 * The search's results, with the project the term names by id first, when it is the kind looked
 * for (a mod's id in the modpack search finds nothing extra). Only on the first page; either
 * answer failing leaves the other.
 */
export async function withProjectById<T extends { id: string; kind?: ProjectKind }>(opts: {
	source: string;
	term: string;
	page?: number;
	kind: ProjectKind;
	lookup: (id: string) => Promise<T>;
	search: () => Promise<T[]>;
}): Promise<T[]> {
	const id = (opts.page ?? 1) > 1 ? null : projectIdIn(opts.source, opts.term);
	if (!id) return opts.search();
	const [found, searched] = await Promise.allSettled([opts.lookup(id), opts.search()]);
	const hit = found.status === 'fulfilled' && (found.value.kind === undefined || found.value.kind === opts.kind) ? found.value : null;
	if (searched.status === 'rejected') {
		if (hit) return [hit];
		throw searched.reason;
	}
	return hit ? [hit, ...searched.value.filter((h) => h.id !== hit.id)] : searched.value;
}
