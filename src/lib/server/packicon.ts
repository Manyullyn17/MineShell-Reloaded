import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { getProvider } from './mods';

/**
 * A server installed from a Modrinth, CurseForge or FTB pack takes the pack's
 * icon as its server icon (what Prism shows for the instance), once: the first
 * time its page is opened without an icon. Removing or replacing it afterwards
 * is not undone. The browser does the scaling (servericon.ts); MineShell only
 * passes the image through, so the canvas may read it.
 */

const TRIED = (id: string) => `packicon.tried:${id}`;
const iconUrls = new Map<string, string | null>();

export async function packIconUrl(instance: ServerInstance): Promise<string | null> {
	if (!instance.packSource || !['modrinth', 'curseforge', 'ftb'].includes(instance.packSource) || !instance.packProjectId) return null;
	const key = `${instance.packSource}:${instance.packProjectId}`;
	if (!iconUrls.has(key)) {
		const project = await getProvider(instance.packSource).getProject(instance.packProjectId).catch(() => null);
		iconUrls.set(key, project?.iconUrl ?? null);
	}
	return iconUrls.get(key) ?? null;
}

export function markPackIconTried(instanceId: string): void {
	db.insert(settings).values({ key: TRIED(instanceId), value: '1' }).onConflictDoNothing().run();
}

/** Whether the page should apply the pack icon now: a pack server, no icon yet, never tried. */
export async function packIconPending(instance: ServerInstance): Promise<boolean> {
	if (!instance.packSource || !instance.packProjectId || instance.status !== 'ready') return false;
	if (db.select().from(settings).where(eq(settings.key, TRIED(instance.id))).get()) return false;
	const hasIcon = await fs.access(path.join(instance.path, 'server-icon.png')).then(() => true, () => false);
	if (hasIcon) markPackIconTried(instance.id);
	return !hasIcon && ['modrinth', 'curseforge', 'ftb'].includes(instance.packSource);
}
