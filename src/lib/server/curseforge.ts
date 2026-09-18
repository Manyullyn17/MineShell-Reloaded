import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';
import { encryptSecret, decryptSecret } from './crypto';
import { CURSEFORGE_API_KEY as ENV_KEY } from './config';

/**
 * CurseForge API key storage and testing. Overridable at runtime from the
 * Settings page (encrypted at rest, same as the RCON password), falling back
 * to the CURSEFORGE_API_KEY env var when nothing has been saved here - so an
 * operator-set env var keeps working, and a key entered through the UI takes
 * priority over it without needing a restart.
 *
 * "Valid" is a snapshot from the last time the effective key was tested
 * (on save, or explicitly) rather than checked on every request - cheap, and
 * good enough for deciding whether the official API or the modpacks.ch
 * mirror should be used, per the metadata-only integration in
 * mods/curseforge.ts.
 */

const KEY_ROW = 'curseforge.api_key_enc';
const VALID_ROW = 'curseforge.api_key_valid';

/** Minecraft's own CurseForge gameId - stable, used by every client of this API. */
const MINECRAFT_GAME_ID = 432;

function row(key: string): string | undefined {
	return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

function writeRow(key: string, value: string): void {
	db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

function storedKey(): string | null {
	return decryptSecret(row(KEY_ROW));
}

/** A key saved through the UI overrides CURSEFORGE_API_KEY from the environment. */
export function getCurseforgeApiKey(): string {
	return storedKey() || ENV_KEY;
}

export function curseforgeKeyConfigured(): boolean {
	return Boolean(getCurseforgeApiKey());
}

/** Where the effective key came from, for display on the Settings page. */
export function curseforgeKeySource(): 'saved' | 'env' | 'none' {
	if (storedKey()) return 'saved';
	if (ENV_KEY) return 'env';
	return 'none';
}

/** Whether the effective key is both configured and last confirmed to work. */
export function curseforgeKeyValid(): boolean {
	if (!getCurseforgeApiKey()) return false;
	return row(VALID_ROW) === 'true';
}

function setValid(valid: boolean): void {
	writeRow(VALID_ROW, valid ? 'true' : 'false');
}

/**
 * Hits the official API with the cheapest possible authenticated call
 * (Minecraft's own game record - nothing to search or page through) just to
 * confirm the key authenticates.
 */
export async function testCurseforgeApiKey(
	key: string
): Promise<{ ok: boolean; message: string }> {
	if (!key) return { ok: false, message: 'No key to test.' };
	try {
		const res = await fetch(`https://api.curseforge.com/v1/games/${MINECRAFT_GAME_ID}`, {
			headers: { 'x-api-key': key, Accept: 'application/json' }
		});
		if (res.ok) return { ok: true, message: 'CurseForge accepted the key.' };
		if (res.status === 401 || res.status === 403) {
			return { ok: false, message: `CurseForge rejected the key (${res.status} ${res.statusText}).` };
		}
		return { ok: false, message: `CurseForge returned an unexpected status (${res.status}).` };
	} catch (err) {
		return {
			ok: false,
			message: `Could not reach CurseForge's API: ${err instanceof Error ? err.message : String(err)}`
		};
	}
}

/**
 * Saves (or, given an empty string, clears) the override, then tests
 * whichever key is now effective - the one just saved, or the environment's
 * if the override was cleared - so curseforgeKeyValid() is always in sync
 * with what will actually be used on the next request.
 */
export async function setCurseforgeApiKey(key: string): Promise<{ ok: boolean; message: string }> {
	const trimmed = key.trim();
	if (trimmed) {
		writeRow(KEY_ROW, encryptSecret(trimmed));
	} else {
		db.delete(settings).where(eq(settings.key, KEY_ROW)).run();
	}

	const effective = getCurseforgeApiKey();
	if (!effective) {
		db.delete(settings).where(eq(settings.key, VALID_ROW)).run();
		return {
			ok: true,
			message: trimmed
				? 'Key removed.'
				: 'Key removed. Browsing falls back to the public modpacks.ch mirror.'
		};
	}

	const result = await testCurseforgeApiKey(effective);
	setValid(result.ok);
	return result;
}

/**
 * Marks the effective key invalid without re-testing - used when a live call
 * comes back 401/403 mid-session (a key revoked after it was last tested),
 * so the next call skips straight to the modpacks.ch fallback instead of
 * trying the official API again.
 */
export function markCurseforgeKeyInvalid(): void {
	setValid(false);
}
