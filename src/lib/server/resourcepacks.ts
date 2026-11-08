import { eq } from 'drizzle-orm';
import { db } from './db';
import { serverInstances, type ServerInstance } from './db/schema';
import { fetchJson, hashUrl } from './download';
import { cached, CACHE_TTL } from './cache';
import { compareVersions } from './java';
import { patchProperties, readProperties } from './properties';
import { InstanceError } from './instanceerror';
import { curseforgeKeyValid, markCurseforgeKeyInvalid } from './curseforge';
import * as official from './mods/curseforge-official';
import { CurseforgeAuthError } from './mods/curseforge-official';
import { curseforgeModProvider as mirror } from './mods/modpacksch';
import { fromJson, parseCodes, toCodes, toJson } from '#lib/shared/mctext.js';

/**
 * The server resource pack (Mods > Resource pack): players' games are pointed at a catalog's own
 * download, `resource-pack` its URL and the SHA-1 from the catalog, so MineShell hosts nothing.
 * Modrinth's resource packs, and CurseForge's through its API with a key (the mirror's search
 * does not find them; their files come from the mirror as mods' do, else from the API). Only a
 * URL the catalog gives is used: a file without one (a CurseForge project that opted out, not on
 * the mirror) is listed but cannot be picked (user, 2026-11-08). A URL typed by hand is downloaded
 * once for its SHA-1.
 *
 * The keys per version, from the server jars' strings (2026-11-08): `resource-pack` from 1.7.10
 * (the oldest checked; 1.6 had `texture-pack`), `resource-pack-hash` from 1.8, renamed
 * `resource-pack-sha1` in 1.9 (the old name is still read), `require-resource-pack` and
 * `resource-pack-prompt` (JSON text) from 1.17, `resource-pack-id` from 1.20.3 (without one the
 * server makes it from the URL, so a new pack gets a new id).
 */

export type PackSource = 'modrinth' | 'curseforge';
export const PACK_SOURCES: PackSource[] = ['modrinth', 'curseforge'];

export type PackHit = {
	id: string;
	name: string;
	author: string | null;
	summary: string | null;
	iconUrl: string | null;
	downloads: number | null;
	projectUrl: string | null;
};

export type PackFile = {
	id: string;
	/** The version's label. */
	name: string;
	channel: string;
	date: string | null;
	/** Null when the catalog gives no download for it. */
	url: string | null;
	sha1: string | null;
	size: number | null;
};

/** What is kept of a pack picked from a catalog. */
export type CatalogPack = {
	source: PackSource;
	projectId: string;
	name: string;
	iconUrl: string | null;
	projectUrl: string | null;
	fileId: string;
	version: string;
	url: string;
};

export type ResourcePackState = {
	/** The Minecraft version reads `resource-pack` at all. */
	supported: boolean;
	url: string;
	sha1: string;
	/** The version reads a SHA-1 for the pack (1.8+). */
	takesSha1: boolean;
	/** Null where the version has no such key. */
	required: boolean | null;
	/** The prompt as colour codes; null where the version has none. */
	prompt: string | null;
	/** The catalog pack, while `resource-pack` is still its URL (not changed by hand since). */
	catalog: CatalogPack | null;
};

/** Players' games refuse bigger packs (250 MB from 1.18; older versions took less). */
export const MAX_PACK_BYTES = 250 * 1024 * 1024;

const atLeast = (minecraft: string, version: string) => compareVersions(minecraft, version) >= 0;
export const readsResourcePack = (minecraft: string) => atLeast(minecraft, '1.7.10');
const readsPrompt = (minecraft: string) => atLeast(minecraft, '1.17');
/** The key the pack's SHA-1 goes under; none before 1.8. */
function hashKey(minecraft: string): string | null {
	if (atLeast(minecraft, '1.9')) return 'resource-pack-sha1';
	return atLeast(minecraft, '1.8') ? 'resource-pack-hash' : null;
}

/** edge.forgecdn.net only redirects to mediafilez: players' games get the file's own address. */
const direct = (url: string) => url.replace(/^https:\/\/edge\.forgecdn\.net\//, 'https://mediafilez.forgecdn.net/');

// -------------------------------------------------------------- Modrinth ---

const MODRINTH = 'https://api.modrinth.com/v2';

type MrHit = { project_id: string; title: string; author: string; description: string; icon_url: string | null; downloads: number; slug: string };
type MrProject = { id: string; slug: string; title: string; icon_url: string | null };
type MrVersion = {
	id: string;
	name: string;
	version_number: string;
	version_type: string;
	date_published: string;
	files: { url: string; primary: boolean; size: number; hashes: { sha1?: string } }[];
};

async function modrinthSearch(term: string, minecraftVersion: string, page: number, limit: number): Promise<PackHit[]> {
	const facets = [['project_type:resourcepack'], ...(minecraftVersion ? [[`versions:${minecraftVersion}`]] : [])];
	const params = new URLSearchParams({
		query: term,
		facets: JSON.stringify(facets),
		index: term ? 'relevance' : 'downloads',
		limit: String(limit),
		offset: String((page - 1) * limit)
	});
	const data = await fetchJson<{ hits: MrHit[] }>(`${MODRINTH}/search?${params}`);
	return data.hits.map((h) => ({
		id: h.project_id,
		name: h.title,
		author: h.author,
		summary: h.description || null,
		iconUrl: h.icon_url,
		downloads: h.downloads,
		projectUrl: `https://modrinth.com/resourcepack/${h.slug}`
	}));
}

async function modrinthFiles(id: string, minecraftVersion: string): Promise<PackFile[]> {
	const params = minecraftVersion ? `?${new URLSearchParams({ game_versions: JSON.stringify([minecraftVersion]) })}` : '';
	const versions = await fetchJson<MrVersion[]>(`${MODRINTH}/project/${encodeURIComponent(id)}/version${params}`);
	return versions.map((v) => {
		const file = v.files.find((f) => f.primary) ?? v.files[0];
		return {
			id: v.id,
			name: v.version_number || v.name,
			channel: v.version_type,
			date: v.date_published,
			url: file?.url ?? null,
			sha1: file?.hashes.sha1 ?? null,
			size: file?.size ?? null
		};
	});
}

async function modrinthProject(id: string): Promise<Pick<CatalogPack, 'name' | 'iconUrl' | 'projectUrl'>> {
	const p = await fetchJson<MrProject>(`${MODRINTH}/project/${encodeURIComponent(id)}`);
	return { name: p.title, iconUrl: p.icon_url, projectUrl: `https://modrinth.com/resourcepack/${p.slug}` };
}

// ------------------------------------------------------------ CurseForge ---

/** The official API, telling a rejected key apart (it is marked, and the page says so). */
async function withKey<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof CurseforgeAuthError) {
			markCurseforgeKeyInvalid();
			throw new InstanceError('CurseForge rejected the API key. Check it under MineShell settings.');
		}
		throw err;
	}
}

/** Mirror first, as for mods; the API's files when the mirror has none (with no URL for an opted-out project). */
async function curseforgeFiles(id: string, minecraftVersion: string): Promise<PackFile[]> {
	try {
		const versions = await mirror.listVersions(id, minecraftVersion ? { minecraftVersion } : undefined);
		const files = versions.map((v) => ({
			id: v.id,
			name: v.versionNumber,
			channel: v.channel,
			date: v.datePublished,
			url: v.files[0]?.url ? direct(v.files[0].url) : null,
			sha1: v.files[0]?.hash?.algo === 'sha1' ? v.files[0].hash.value : null,
			size: v.files[0]?.size ?? null
		}));
		if (files.length) return files;
	} catch {
		// Not on the mirror: the API's list below.
	}
	if (!curseforgeKeyValid()) return [];
	const files = await withKey(() => official.resourcePackFiles(id, minecraftVersion));
	return files.map((f) => ({ id: f.id, name: f.name, channel: f.channel, date: f.date, url: f.url ? direct(f.url) : null, sha1: f.sha1, size: f.size }));
}

async function curseforgeProject(id: string): Promise<Pick<CatalogPack, 'name' | 'iconUrl' | 'projectUrl'>> {
	const hit = curseforgeKeyValid() ? await withKey(() => official.getProject(id)) : await mirror.getProject(id);
	return { name: hit.name, iconUrl: hit.iconUrl, projectUrl: hit.projectUrl };
}

// ----------------------------------------------------------------- both ---

/** Without a term, the most downloaded. `note` says why a catalog cannot be searched. */
export async function searchResourcePacks(source: PackSource, term: string, minecraftVersion: string, page = 1, fresh = false): Promise<{ hits: PackHit[]; note: string | null }> {
	const limit = 20;
	if (source === 'curseforge' && !curseforgeKeyValid()) {
		return { hits: [], note: "Searching CurseForge's resource packs needs a CurseForge API key (MineShell settings): the mirror MineShell uses without one does not find them." };
	}
	const hits = await cached(`resourcepacks:search:${source}:${minecraftVersion}:${page}:${term}`, CACHE_TTL.DEFAULT, () =>
		source === 'modrinth'
			? modrinthSearch(term, minecraftVersion, page, limit)
			: withKey(async () =>
					(await official.searchResourcePacks(term, minecraftVersion, page, limit)).map((h) => ({
						id: h.id,
						name: h.name,
						author: h.author,
						summary: h.summary,
						iconUrl: h.iconUrl,
						downloads: h.downloads,
						projectUrl: h.projectUrl
					}))
				),
		{ fresh }
	);
	return { hits, note: null };
}

/** A pack's files for the server's Minecraft version, newest first. */
export function resourcePackFiles(source: PackSource, id: string, minecraftVersion: string): Promise<PackFile[]> {
	return cached(`resourcepacks:files:${source}:${id}:${minecraftVersion}`, CACHE_TTL.DEFAULT, () =>
		source === 'modrinth' ? modrinthFiles(id, minecraftVersion) : curseforgeFiles(id, minecraftVersion)
	);
}

function catalogOf(instance: ServerInstance): CatalogPack | null {
	if (!instance.resourcePack) return null;
	try {
		return JSON.parse(instance.resourcePack) as CatalogPack;
	} catch {
		return null;
	}
}

/** The prompt in server.properties (JSON text) as colour codes; text that is not JSON as itself. */
function promptCodes(value: string): string {
	if (!value.trim()) return '';
	try {
		const spans = fromJson(JSON.parse(value));
		if (spans) return toCodes(spans);
	} catch {
		// Not JSON: shown as it is.
	}
	return value;
}

export async function resourcePackState(instance: ServerInstance): Promise<ResourcePackState> {
	const { values } = await readProperties(instance.path);
	const minecraft = instance.minecraftVersion;
	const url = values['resource-pack'] ?? '';
	const key = hashKey(minecraft);
	const catalog = catalogOf(instance);
	return {
		supported: readsResourcePack(minecraft),
		url,
		sha1: (key && values[key]) || values['resource-pack-hash'] || '',
		takesSha1: key !== null,
		required: readsPrompt(minecraft) ? values['require-resource-pack'] === 'true' : null,
		prompt: readsPrompt(minecraft) ? promptCodes(values['resource-pack-prompt'] ?? '') : null,
		catalog: catalog && url && catalog.url === url ? catalog : null
	};
}

function checkSupported(instance: ServerInstance) {
	if (!readsResourcePack(instance.minecraftVersion)) {
		throw new InstanceError(`Minecraft ${instance.minecraftVersion} has no server resource pack.`);
	}
}

/** Points players at a pack: the URL and its SHA-1, a stale id and old-named hash cleared. */
async function writePack(instance: ServerInstance, url: string, sha1: string, catalog: CatalogPack | null) {
	const { values } = await readProperties(instance.path);
	const key = hashKey(instance.minecraftVersion);
	const patch: Record<string, string> = { 'resource-pack': url };
	if (key) patch[key] = sha1;
	if (key === 'resource-pack-sha1' && values['resource-pack-hash']) patch['resource-pack-hash'] = '';
	// An id set by hand would make players' games take a new pack for the old one.
	if (values['resource-pack-id']) patch['resource-pack-id'] = '';
	await patchProperties(instance.path, patch);
	db.update(serverInstances)
		.set({ resourcePack: catalog ? JSON.stringify(catalog) : null, updatedAt: Date.now() })
		.where(eq(serverInstances.id, instance.id))
		.run();
}

/** A catalog pack's file, by the URL and SHA-1 the catalog gives. */
export async function useCatalogPack(instance: ServerInstance, source: PackSource, projectId: string, fileId: string): Promise<CatalogPack> {
	checkSupported(instance);
	const files = await resourcePackFiles(source, projectId, instance.minecraftVersion);
	const file = files.find((f) => f.id === fileId);
	if (!file) throw new InstanceError(`That version is not one of this pack's for Minecraft ${instance.minecraftVersion}.`);
	if (!file.url) throw new InstanceError('CurseForge gives no download for this file: its author keeps it to their own site.');
	if (!file.sha1) throw new InstanceError('The catalog gives no SHA-1 for this file, which players need to tell when it changed.');
	const project = source === 'modrinth' ? await modrinthProject(projectId) : await curseforgeProject(projectId);
	const catalog: CatalogPack = { source, projectId, ...project, fileId, version: file.name, url: file.url };
	await writePack(instance, file.url, file.sha1, catalog);
	return catalog;
}

/** A URL typed by hand: downloaded once for its SHA-1 (not kept). */
export async function useUrlPack(instance: ServerInstance, url: string): Promise<void> {
	checkSupported(instance);
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		throw new InstanceError('That is not a web address.');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new InstanceError('The address must start with https:// or http://.');
	let sha1 = '';
	if (hashKey(instance.minecraftVersion)) {
		try {
			sha1 = (await hashUrl(parsed.href, MAX_PACK_BYTES)).sha1;
		} catch (err) {
			throw new InstanceError(`Could not download the pack to work out its SHA-1: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	await writePack(instance, parsed.href, sha1, null);
}

export async function removeResourcePack(instance: ServerInstance): Promise<void> {
	await writePack(instance, '', '', null);
}

/** Whether players must take the pack, and what they are asked (1.17+). */
export async function setResourcePackOptions(instance: ServerInstance, required: boolean, prompt: string): Promise<void> {
	if (!readsPrompt(instance.minecraftVersion)) throw new InstanceError(`Minecraft ${instance.minecraftVersion} has no such settings for the pack.`);
	const text = prompt.trim() ? JSON.stringify(toJson(parseCodes(prompt))) : '';
	await patchProperties(instance.path, { 'require-resource-pack': required ? 'true' : 'false', 'resource-pack-prompt': text });
}
