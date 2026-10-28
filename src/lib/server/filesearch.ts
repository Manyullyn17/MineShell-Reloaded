import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKUP_MOD_FOLDERS, MAP_MOD_FOLDERS } from './diskusage';
import { isSearchable, safeJoin } from './files';
import { isLoaderInstallEntry } from './instances';
import { worldFolderNames } from './worlds';

/**
 * "Which config sets this?": the lines of a server's text files that contain
 * some text, each opening in the editor at its line. Configs and scripts, not
 * what holds none: mods, logs (the Logs tab searches those), libraries and
 * the loader's files, MineShell's own folders, map tiles, backup mods' copies,
 * and worlds apart from their serverconfig/. Binary files and files too big
 * for the editor are skipped. The same walk matches file and folder names,
 * there in mods/, logs/ and crash-reports/ too (a jar or a report found by name).
 */

export type FileHit = { path: string; count: number; lines: { n: number; text: string }[] };
export type NameHit = { path: string; isDirectory: boolean };
export type FileSearch = {
	query: string;
	folder: string;
	/** Files and folders whose name contains the text. */
	names: NameHit[];
	files: FileHit[];
	total: number;
	searched: number;
	/** Stopped early: reading took too long, or too many lines matched. */
	partial: boolean;
};

export const SHOWN_PER_FILE = 20;
/** Matching lines kept in all; the search stops there. */
const MAX_LINES = 500;
const MAX_NAMES = 200;
/** Stop reading after this long; what was found is shown, marked partial. */
const BUDGET_MS = 8000;
const MAX_DEPTH = 16;
/** A line this long is cut down to the part around the match. */
const LINE_CHARS = 240;

const SKIPPED_TOPS = new Set(['libraries', 'versions', 'old-configs', 'backups', 'simplebackups']);
/** Matched by name, not read: jars, and logs (the Logs tab searches those). */
const NAMES_ONLY = new Set(['mods', 'logs', 'crash-reports']);

function shown(line: string, at: number, length: number): string {
	if (line.length <= LINE_CHARS) return line;
	const start = Math.max(0, Math.min(at - 80, line.length - LINE_CHARS));
	return `${start > 0 ? '…' : ''}${line.slice(start, start + LINE_CHARS)}${start + LINE_CHARS < line.length ? '…' : ''}`.replace(/^…\s+/, '…');
}

export async function searchFiles(root: string, query: string, folder = '', now = Date.now): Promise<FileSearch> {
	const q = query.trim();
	const result: FileSearch = { query: q, folder, names: [], files: [], total: 0, searched: 0, partial: false };
	if (q.length < 2) return result;
	const needle = q.toLowerCase();
	const started = now();
	const worlds = new Set((await worldFolderNames(root)).map((w) => w.split('/')[0]));

	/** What is left out at the server folder's top. */
	const skipTop = (name: string, isDir: boolean) =>
		name.startsWith('.') || SKIPPED_TOPS.has(name) || name in MAP_MOD_FOLDERS || name in BACKUP_MOD_FOLDERS || (isDir && isLoaderInstallEntry(name));

	let linesFull = false;
	async function visit(rel: string, depth: number): Promise<void> {
		if (result.partial || depth > MAX_DEPTH) return;
		const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
		entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
		for (const entry of entries) {
			if (result.partial) return;
			if (now() - started > BUDGET_MS) {
				result.partial = true;
				return;
			}
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			const parts = child.split('/');
			if (parts.length === 1 && skipTop(entry.name, entry.isDirectory())) continue;
			if (entry.name.startsWith('.')) continue;
			// A world: only its serverconfig/ (Forge's per-world configs).
			if (worlds.has(parts[0]) && !(parts.length === 1 || parts[1] === 'serverconfig')) continue;
			if (entry.name.toLowerCase().includes(needle) && result.names.length < MAX_NAMES) {
				result.names.push({ path: child, isDirectory: entry.isDirectory() });
			}
			if (entry.isDirectory()) {
				await visit(child, depth + 1);
				continue;
			}
			if (!entry.isFile() || (worlds.has(parts[0]) && parts.length < 3) || NAMES_ONLY.has(parts[0])) continue;
			// Enough lines: the rest of the walk only matches names.
			if (result.total >= MAX_LINES) {
				linesFull = true;
				continue;
			}
			const stat = await fs.stat(path.join(root, child)).catch(() => null);
			if (!stat || !isSearchable(entry.name, stat.size)) continue;
			const buf = await fs.readFile(path.join(root, child)).catch(() => null);
			if (!buf || buf.subarray(0, 4096).includes(0)) continue;
			result.searched++;
			const text = buf.toString('utf8');
			if (!text.toLowerCase().includes(needle)) continue;
			const hit: FileHit = { path: child, count: 0, lines: [] };
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length && result.total < MAX_LINES; i++) {
				const at = lines[i].toLowerCase().indexOf(needle);
				if (at < 0) continue;
				hit.count++;
				result.total++;
				if (hit.lines.length < SHOWN_PER_FILE) hit.lines.push({ n: i + 1, text: shown(lines[i], at, needle.length) });
			}
			result.files.push(hit);
		}
	}

	// The folder asked for, or the whole server; a folder path outside it is refused.
	const start = folder ? path.relative(root, safeJoin(root, folder)) : '';
	await visit(start, start ? start.split(path.sep).length : 0);
	result.partial ||= linesFull;
	return result;
}
