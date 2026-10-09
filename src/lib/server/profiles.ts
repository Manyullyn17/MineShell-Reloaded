import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './config';
import { USER_AGENT } from './download';

/**
 * Player names for UUIDs the server itself has no name for (a world imported
 * without its usercache.json), from Mojang's session server. Kept in
 * cache/profiles.json: a name for 30 days (names change, rarely), "no such
 * account" for a day; a failed request is not kept, so it is asked again.
 *
 * Only online-mode UUIDs (version 4) are Mojang accounts. An offline-mode
 * server derives version 3 UUIDs from the name ("OfflinePlayer:<name>",
 * MD5), which cannot be turned back into it.
 */

const NAME_TTL_MS = 30 * 24 * 60 * 60_000;
const MISS_TTL_MS = 24 * 60 * 60_000;
/** Per call: an imported world can hold hundreds; the rest come on the next look. */
const MAX_LOOKUPS = 60;
const PARALLEL = 4;

type Entry = { name: string | null; at: number };
let store: Record<string, Entry> | null = null;
const file = () => path.join(CACHE_DIR, 'profiles.json');

export function isOfflineUuid(uuid: string): boolean {
	return uuid.length === 36 && uuid[14] === '3';
}

function fresh(entry: Entry | undefined): entry is Entry {
	return !!entry && Date.now() - entry.at < (entry.name ? NAME_TTL_MS : MISS_TTL_MS);
}

async function load(): Promise<Record<string, Entry>> {
	if (store) return store;
	try {
		store = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, Entry>;
	} catch {
		store = {};
	}
	return store;
}

async function save(): Promise<void> {
	if (!store) return;
	await fs.mkdir(CACHE_DIR, { recursive: true });
	const temp = `${file()}.${process.pid}.tmp`;
	await fs.writeFile(temp, JSON.stringify(store));
	await fs.rename(temp, file());
}

/** Names already looked up, without asking Mojang. */
export async function cachedProfileNames(uuids: string[]): Promise<Map<string, string>> {
	const known = await load();
	const names = new Map<string, string>();
	for (const uuid of uuids) {
		const entry = known[uuid.toLowerCase()];
		if (fresh(entry) && entry.name) names.set(uuid.toLowerCase(), entry.name);
	}
	return names;
}

/** The account's current name; null when Mojang has no such account; throws when it could not ask. */
async function askMojang(uuid: string): Promise<string | null> {
	const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
	});
	if (res.status === 204 || res.status === 404) return null;
	if (!res.ok) throw new Error(`Mojang answered ${res.status}`);
	const text = await res.text();
	if (!text.trim()) return null;
	const name = (JSON.parse(text) as { name?: unknown }).name;
	return typeof name === 'string' && name ? name : null;
}

/**
 * Names for these UUIDs: cached ones, and up to MAX_LOOKUPS asked for now.
 * Offline-mode UUIDs are never asked about.
 */
export async function lookUpProfileNames(uuids: string[]): Promise<Map<string, string>> {
	const known = await load();
	const ids = [...new Set(uuids.map((u) => u.toLowerCase()))];
	const missing = ids.filter((u) => !isOfflineUuid(u) && !fresh(known[u])).slice(0, MAX_LOOKUPS);
	let changed = false;
	let next = 0;
	const worker = async () => {
		while (next < missing.length) {
			const uuid = missing[next++];
			try {
				known[uuid] = { name: await askMojang(uuid), at: Date.now() };
				changed = true;
			} catch {
				// Rate-limited or unreachable: asked again next time.
			}
		}
	};
	await Promise.all(Array.from({ length: PARALLEL }, worker));
	if (changed) await save().catch(() => undefined);
	return cachedProfileNames(ids);
}

/** Tests: forget what was loaded, so a new cache file is read. */
export function resetProfileCache(): void {
	store = null;
}
