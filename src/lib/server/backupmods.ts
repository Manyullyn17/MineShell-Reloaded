import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { indexMods } from './crashdiag';
import { directorySize } from './files';
import { modsDir } from './mods';

/**
 * Mods that copy the world themselves, beside MineShell's snapshots and backup
 * copies: the same job twice, with the server lagging while they zip (AromaBackup
 * on MeatballCraft: 2 minutes at every start, 24 GB kept). Found by the jars'
 * own ids; the folder and whether it is switched off are read from the mod's
 * config where its format is known (docs/notes/worlds.md), the default otherwise.
 */

type Config = { folder: string; off: boolean };

type Known = {
	ids: string[];
	name: string;
	/** When it copies, for the notice. */
	when: string;
	read: (root: string) => Promise<Config>;
};

const readText = (file: string) => fs.readFile(file, 'utf8').catch(() => null);

const KNOWN: Known[] = [
	{
		ids: ['aromabackup'],
		name: 'AromaBackup',
		when: 'when the world loads and on its own schedule',
		// Forge 1.12 .cfg: S:location=./backups, I:delay=30 (0: no schedule), B:onStartup=true.
		read: async (root) => {
			const text = (await readText(path.join(root, 'config', 'aroma1997', 'aromabackup.cfg'))) ?? '';
			const value = (key: string) => text.match(new RegExp(`^\\s*${key}=(.*)$`, 'm'))?.[1].trim();
			return { folder: value('S:location') || './backups', off: value('I:delay') === '0' && value('B:onStartup') === 'false' };
		}
	},
	{
		ids: ['simplebackups'],
		name: 'Simple Backups',
		when: 'on its own schedule',
		read: async (root) => {
			const text = (await readText(path.join(root, 'config', 'simplebackups-common.toml'))) ?? '';
			return {
				folder: text.match(/^\s*outputPath\s*=\s*"([^"]*)"/m)?.[1] || 'simplebackups',
				off: /^\s*enabled\s*=\s*false\b/m.test(text)
			};
		}
	},
	// Not checked against a real jar's config yet: their default folders.
	{ ids: ['ftbbackups', 'ftbbackups2'], name: 'FTB Backups', when: 'on its own schedule', read: async () => ({ folder: 'backups', off: false }) },
	{ ids: ['textile_backup'], name: 'Textile Backup', when: 'on its own schedule', read: async () => ({ folder: 'backup', off: false }) }
];

export type BackupMod = {
	name: string;
	fileName: string;
	when: string;
	/** As the server folder sees it: relative inside it, absolute outside. */
	folder: string;
	/** What its folder holds; null when the folder is outside the server's, where it is not measured. */
	bytes: number | null;
};

/** Enabled backup mods that are not switched off in their config. */
export async function backupModsOf(instance: Pick<ServerInstance, 'path'>): Promise<BackupMod[]> {
	const root = path.resolve(instance.path);
	const found: BackupMod[] = [];
	for (const jar of await indexMods(modsDir(instance.path))) {
		const known = jar.enabled && KNOWN.find((k) => k.ids.some((id) => jar.ids.includes(id)));
		if (!known || found.some((f) => f.name === known.name)) continue;
		const config = await known.read(root);
		if (config.off) continue;
		const full = path.resolve(root, config.folder);
		const inside = full === root || full.startsWith(root + path.sep);
		found.push({
			name: known.name,
			fileName: jar.fileName,
			when: known.when,
			folder: inside ? path.relative(root, full) || '.' : full,
			bytes: inside && full !== root ? await directorySize(full).catch(() => 0) : null
		});
	}
	return found;
}

/** What it does, in a sentence for the disk usage page and the World tab. */
export function backupModNote(mod: BackupMod): string {
	return `${mod.name} also copies the world, ${mod.when}, into ${mod.folder === '.' ? 'the server folder' : `${mod.folder}/`}: the job MineShell's snapshots and backup copies already do.`;
}
