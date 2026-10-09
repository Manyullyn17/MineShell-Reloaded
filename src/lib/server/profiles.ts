import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './config';
import { USER_AGENT } from './download';

/**
 * Player profiles from Mojang's session server: the name, for UUIDs the server
 * itself has none for (a world imported without its usercache.json), and the
 * skin, for the player's face. Kept in cache/profiles.json: an account for 2
 * days (names and skins change), "no such account" for a day; a failed request
 * is not kept, so it is asked again.
 *
 * Only online-mode UUIDs (version 4) are Mojang accounts. An offline-mode
 * server derives version 3 UUIDs from the name ("OfflinePlayer:<name>",
 * MD5), which cannot be turned back into it.
 */

const FOUND_TTL_MS = 2 * 24 * 60 * 60_000;
const MISS_TTL_MS = 24 * 60 * 60_000;
/** Per call: an imported world can hold hundreds; the rest come on the next look. */
const MAX_LOOKUPS = 60;
const PARALLEL = 4;

/** `skin`: the skin's texture id on textures.minecraft.net, null for the default skins. */
type Entry = { name: string | null; skin?: string | null; at: number };
export type Profile = { name: string; skin: string | null };
let store: Record<string, Entry> | null = null;
const file = () => path.join(CACHE_DIR, 'profiles.json');

export function isOfflineUuid(uuid: string): boolean {
	return uuid.length === 36 && uuid[14] === '3';
}

function fresh(entry: Entry | undefined): entry is Entry {
	if (!entry) return false;
	// Entries from before skins were kept are asked again.
	if (entry.name && entry.skin === undefined) return false;
	return Date.now() - entry.at < (entry.name ? FOUND_TTL_MS : MISS_TTL_MS);
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
	return new Map([...(await cachedProfiles(uuids))].map(([uuid, p]) => [uuid, p.name]));
}

/** A skin's texture id: the hex name of its file on textures.minecraft.net. */
export const TEXTURE_ID = /^[0-9a-f]{32,128}$/;

type MojangProfile = { name?: unknown; properties?: { name?: unknown; value?: unknown }[] };

/** The skin's texture id, from the profile's base64 "textures" property. */
export function skinTexture(profile: MojangProfile): string | null {
	const textures = profile.properties?.find((p) => p.name === 'textures')?.value;
	if (typeof textures !== 'string') return null;
	try {
		const url = (JSON.parse(Buffer.from(textures, 'base64').toString('utf8')) as { textures?: { SKIN?: { url?: unknown } } }).textures?.SKIN?.url;
		const id = typeof url === 'string' ? url.split('/').pop() : null;
		return id && TEXTURE_ID.test(id) ? id : null;
	} catch {
		return null;
	}
}

/** The account's name and skin; null when Mojang has no such account; throws when it could not ask. */
async function askMojang(uuid: string): Promise<{ name: string; skin: string | null } | null> {
	const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
	});
	if (res.status === 204 || res.status === 404) return null;
	if (!res.ok) throw new Error(`Mojang answered ${res.status}`);
	const text = await res.text();
	if (!text.trim()) return null;
	const profile = JSON.parse(text) as MojangProfile;
	return typeof profile.name === 'string' && profile.name ? { name: profile.name, skin: skinTexture(profile) } : null;
}

/** Profiles already looked up, without asking Mojang. */
export async function cachedProfiles(uuids: string[]): Promise<Map<string, Profile>> {
	const known = await load();
	const profiles = new Map<string, Profile>();
	for (const uuid of uuids) {
		const entry = known[uuid.toLowerCase()];
		if (fresh(entry) && entry.name) profiles.set(uuid.toLowerCase(), { name: entry.name, skin: entry.skin ?? null });
	}
	return profiles;
}

/** Names for these UUIDs (lookUpProfiles). */
export async function lookUpProfileNames(uuids: string[]): Promise<Map<string, string>> {
	return new Map([...(await lookUpProfiles(uuids))].map(([uuid, p]) => [uuid, p.name]));
}

/**
 * Profiles for these UUIDs: cached ones, and up to MAX_LOOKUPS asked for now.
 * Offline-mode UUIDs are never asked about.
 */
export async function lookUpProfiles(uuids: string[]): Promise<Map<string, Profile>> {
	const known = await load();
	const ids = [...new Set(uuids.map((u) => u.toLowerCase()))];
	const missing = ids.filter((u) => !isOfflineUuid(u) && !fresh(known[u])).slice(0, MAX_LOOKUPS);
	let changed = false;
	let next = 0;
	const worker = async () => {
		while (next < missing.length) {
			const uuid = missing[next++];
			try {
				const profile = await askMojang(uuid);
				known[uuid] = { name: profile?.name ?? null, skin: profile?.skin ?? null, at: Date.now() };
				changed = true;
			} catch {
				// Rate-limited or unreachable: asked again next time.
			}
		}
	};
	await Promise.all(Array.from({ length: PARALLEL }, worker));
	if (changed) await save().catch(() => undefined);
	return cachedProfiles(ids);
}

/**
 * A skin image, downloaded once into cache/skins/ (a texture id names one image
 * for good, so it never needs fetching again). Null when it is not a skin.
 */
export async function skinFile(texture: string): Promise<Buffer | null> {
	if (!TEXTURE_ID.test(texture)) return null;
	const cached = path.join(CACHE_DIR, 'skins', `${texture}.png`);
	const kept = await fs.readFile(cached).catch(() => null);
	if (kept) return kept;
	const res = await fetch(`https://textures.minecraft.net/texture/${texture}`, { headers: { 'User-Agent': USER_AGENT } }).catch(() => null);
	if (!res?.ok) return null;
	const bytes = Buffer.from(await res.arrayBuffer());
	// A PNG, and skin-sized (64x64, or 64x32 from before 1.8).
	if (bytes.length > 64 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
	await fs.mkdir(path.dirname(cached), { recursive: true });
	await fs.writeFile(cached, bytes);
	return bytes;
}

/** Tests: forget what was loaded, so a new cache file is read. */
export function resetProfileCache(): void {
	store = null;
}
