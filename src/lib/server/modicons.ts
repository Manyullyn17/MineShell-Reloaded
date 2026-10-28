import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { instanceMods, mods, type ServerInstance } from './db/schema';
import { CACHE_DIR } from './config';
import { downloadFile } from './download';
import { describeModJar } from './crashdiag';
import { openZipFile } from './zip';
import { safeJoin } from './files';
import { modsDir } from './mods';

/**
 * Pictures for the Mods tab's installed list. A mod from Modrinth or
 * CurseForge shows its project's icon, downloaded once into the cache
 * (`cache/mod-icons/`, named by the address) and served from there; any
 * other jar, or one whose icon cannot be had, the picture it names itself
 * (Fabric/Quilt `icon`, Forge `logoFile`, which is often a wide banner).
 * Only PNG, JPEG, GIF and WebP are served, recognised by their first bytes,
 * so nothing a browser would run comes from MineShell's own origin.
 */

export type ModIcon = { bytes: Buffer; type: string };

const ICON_DIR = () => path.join(CACHE_DIR, 'mod-icons');
const MAX_BYTES = 1024 * 1024;
/** An address that failed is not tried again for this long. */
const RETRY_MS = 60 * 60_000;
const failed = new Map<string, number>();
const fetching = new Map<string, Promise<Buffer | null>>();

export function imageType(bytes: Buffer): string | null {
	if (bytes.length > MAX_BYTES || bytes.length < 12) return null;
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
	if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
	return null;
}

/** The project icon address MineShell has for this jar (a disabled one's record may be under its enabled name). */
function recordedIconUrl(instance: ServerInstance, fileName: string): string | null {
	const recorded = [...new Set([fileName, fileName.replace(/\.disabled$/, '')])].map((f) => path.join('mods', f));
	const row = db
		.select({ iconUrl: mods.iconUrl })
		.from(instanceMods)
		.innerJoin(mods, eq(instanceMods.modId, mods.id))
		.where(and(eq(instanceMods.instanceId, instance.id), inArray(instanceMods.filePath, recorded)))
		.get();
	return row?.iconUrl ?? null;
}

/** A project icon from the cache, downloaded the first time. */
async function remoteIcon(url: string, now = Date.now()): Promise<Buffer | null> {
	const file = path.join(ICON_DIR(), crypto.createHash('sha1').update(url).digest('hex'));
	const kept = await fs.readFile(file).catch(() => null);
	if (kept) return kept;
	if (now - (failed.get(url) ?? 0) < RETRY_MS) return null;
	let pending = fetching.get(url);
	if (!pending) {
		pending = (async () => {
			try {
				await downloadFile(url, file);
				const bytes = await fs.readFile(file);
				if (imageType(bytes)) return bytes;
				await fs.rm(file, { force: true });
			} catch {
				await fs.rm(`${file}.part`, { force: true });
			}
			failed.set(url, Date.now());
			return null;
		})().finally(() => fetching.delete(url));
		fetching.set(url, pending);
	}
	return pending;
}

/** The picture a jar names for itself. */
async function jarLogo(file: string): Promise<Buffer | null> {
	const logo = (await describeModJar(file))?.logo?.replace(/^\/+/, '');
	if (!logo) return null;
	const zip = await openZipFile(file).catch(() => null);
	const entry = zip?.entries.find((e) => e.name === logo);
	if (!zip || !entry || entry.size > MAX_BYTES) return null;
	return zip.read(entry).catch(() => null);
}

export async function modIcon(instance: ServerInstance, fileName: string): Promise<ModIcon | null> {
	// A file name in mods/, nothing further down or up.
	if (!/^[^/\\]+\.jar(\.disabled)?$/i.test(fileName) || fileName.startsWith('.')) return null;
	const jar = safeJoin(modsDir(instance.path), fileName);
	const url = recordedIconUrl(instance, fileName);
	for (const source of [url ? () => remoteIcon(url) : null, () => jarLogo(jar)]) {
		const bytes = source ? await source() : null;
		const type = bytes && imageType(bytes);
		if (bytes && type) return { bytes, type };
	}
	return null;
}

/** Forgets failed addresses, for tests. */
export function resetModIcons(): void {
	failed.clear();
}
