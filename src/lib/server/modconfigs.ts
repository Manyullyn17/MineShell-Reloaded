import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModJar } from './crashdiag';
import { serverWorldName } from './packworld';

/**
 * Which config files belong to which mod, for the Mods tab's Configs: files in config/ (and
 * its folders), defaultconfigs/ and the world's serverconfig/ whose name or folder is a mod
 * id or name the jar declares, compared without case and punctuation (`jei-client.toml`,
 * `config/Mekanism/general.toml`, `serverconfig/create-server.toml`, 1.12's `Mekanism.cfg`).
 * A file no jar names is left out: it is still in Files.
 */

const CONFIG_EXTENSIONS = /\.(toml|cfg|json|json5|jsonc|snbt|properties|ya?ml|conf|ini|txt)$/i;
/** Ids every jar of a loader declares, or ones too short to name a file by. */
const GENERIC_IDS = new Set(['minecraft', 'forge', 'neoforge', 'fml', 'mcp', 'java', 'fabric', 'fabricloader', 'quiltloader', 'cleanroom', 'config', 'common', 'server', 'client']);
/** Folders deeper than this under config/ are a mod's data more than its settings. */
const MAX_DEPTH = 3;
const MAX_FILES = 10_000;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function listFiles(root: string, rel: string, depth: number, out: string[]): Promise<void> {
	if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
	const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
	entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const child = `${rel}/${entry.name}`;
		if (entry.isDirectory()) await listFiles(root, child, depth + 1, out);
		else if (entry.isFile() && CONFIG_EXTENSIONS.test(entry.name) && out.length < MAX_FILES) out.push(child);
	}
}

/** The names a file goes by: its folder under config/, and its own name without `-common` and the like. */
function fileKeys(file: string): string[] {
	const parts = file.split('/');
	const base = parts.at(-1)!.replace(/\.[^.]+$/, '').replace(/[-_.](common|server|client|startup|general|config|options|settings)$/i, '');
	const keys = [squash(base)];
	if (parts[0] === 'config' && parts.length > 2) keys.push(squash(parts[1]));
	return keys.filter((k) => k.length >= 3);
}

/** Config files per mod jar (file name as in the mods folder), for jars that have any. */
export async function configFilesByMod(root: string, jars: Pick<ModJar, 'fileName' | 'ids' | 'names'>[]): Promise<Record<string, string[]>> {
	const files: string[] = [];
	const world = await serverWorldName(root).catch(() => 'world');
	await listFiles(root, `${world}/serverconfig`, MAX_DEPTH, files);
	await listFiles(root, 'config', 1, files);
	await listFiles(root, 'defaultconfigs', MAX_DEPTH, files);
	const order = new Map(files.map((f, i) => [f, i]));
	const byKey = new Map<string, string[]>();
	for (const file of files) {
		for (const key of new Set(fileKeys(file))) byKey.set(key, [...(byKey.get(key) ?? []), file]);
	}
	const out: Record<string, string[]> = {};
	for (const jar of jars) {
		const keys = new Set([...jar.ids.map(squash).filter((k) => k.length >= 3 && !GENERIC_IDS.has(k)), ...jar.names.map(squash).filter((k) => k.length >= 4 && !GENERIC_IDS.has(k))]);
		const found = new Set<string>();
		for (const key of keys) for (const file of byKey.get(key) ?? []) found.add(file);
		// The world's own first, then config/, then defaultconfigs/.
		if (found.size) out[jar.fileName] = [...found].sort((a, b) => order.get(a)! - order.get(b)!);
	}
	return out;
}
