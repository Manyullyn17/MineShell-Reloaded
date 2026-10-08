import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

/**
 * The file browser is the escape hatch for everything MineShell does not model:
 * mod configs, datapacks, dropped-in jars, logs. Every path is resolved against
 * the instance root and rejected if it escapes, so a crafted `../../` cannot
 * reach outside the instance directory.
 */

export class PathEscapeError extends Error {
	constructor() {
		super('That path is outside the instance directory.');
	}
}

export function safeJoin(root: string, relative: string): string {
	const normalisedRoot = path.resolve(root);
	const target = path.resolve(normalisedRoot, relative.replace(/^[/\\]+/, ''));
	if (target !== normalisedRoot && !target.startsWith(normalisedRoot + path.sep)) {
		throw new PathEscapeError();
	}
	return target;
}

export type DirEntry = {
	name: string;
	relPath: string;
	isDirectory: boolean;
	size: number;
	modified: number;
	/** Best guess at whether the browser should offer an editor. */
	editable: boolean;
};

const TEXT_EXTENSIONS = new Set([
	'.txt', '.json', '.json5', '.properties', '.yml', '.yaml', '.toml', '.cfg', '.conf',
	'.ini', '.log', '.md', '.sh', '.env', '.lock', '.snbt', '.mcmeta', '.xml', '.csv', '.js', '.lua'
]);

const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export function looksEditable(name: string, size: number): boolean {
	if (size > MAX_EDIT_BYTES) return false;
	const ext = path.extname(name).toLowerCase();
	if (TEXT_EXTENSIONS.has(ext)) return true;
	return ext === '' && /^(eula|banned-ips|ops|whitelist)$/i.test(path.basename(name));
}

export async function listDirectory(root: string, relative: string): Promise<DirEntry[]> {
	const dir = safeJoin(root, relative);
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const results = await Promise.all(
		entries.map(async (entry) => {
			const full = path.join(dir, entry.name);
			let stat;
			try {
				stat = await fs.stat(full);
			} catch {
				return null;
			}
			const relPath = path.relative(path.resolve(root), full);
			return {
				name: entry.name,
				relPath,
				isDirectory: stat.isDirectory(),
				size: stat.size,
				modified: stat.mtimeMs,
				editable: !stat.isDirectory() && looksEditable(entry.name, stat.size)
			} satisfies DirEntry;
		})
	);
	return results
		.filter((e): e is DirEntry => e !== null)
		.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.name.localeCompare(b.name, undefined, { numeric: true });
		});
}

export async function readTextFile(root: string, relative: string): Promise<string> {
	const target = safeJoin(root, relative);
	const stat = await fs.stat(target);
	if (stat.size > MAX_EDIT_BYTES) {
		throw new Error('That file is too large to open in the editor. Download it instead.');
	}
	return fs.readFile(target, 'utf8');
}

export async function writeTextFile(root: string, relative: string, contents: string): Promise<void> {
	const target = safeJoin(root, relative);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, contents, 'utf8');
}

export function fileStream(root: string, relative: string) {
	return createReadStream(safeJoin(root, relative));
}

export async function statFile(root: string, relative: string) {
	return fs.stat(safeJoin(root, relative));
}

export async function deleteEntry(root: string, relative: string): Promise<void> {
	const target = safeJoin(root, relative);
	if (target === path.resolve(root)) throw new Error('The instance root cannot be deleted here.');
	await fs.rm(target, { recursive: true, force: true });
}

export async function createDirectory(root: string, relative: string): Promise<void> {
	await fs.mkdir(safeJoin(root, relative), { recursive: true });
}

export async function renameEntry(root: string, from: string, to: string): Promise<void> {
	const source = safeJoin(root, from);
	const target = safeJoin(root, to);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.rename(source, target);
}

/**
 * Where an uploaded file goes inside `dir`. A file picked with the button is
 * named by its own name; one from a dropped folder (`withFolders`) keeps the
 * folders it was in, but never "." or ".." steps out of them.
 */
export function uploadPath(dir: string, name: string, withFolders: boolean): string {
	const parts = name.split(/[/\\]+/).filter((p) => p !== '' && p !== '.');
	if (!parts.length || parts.includes('..')) throw new Error(`${name} is not a file name.`);
	return path.posix.join(dir, ...(withFolders ? parts : parts.slice(-1)));
}

export async function saveUpload(root: string, relative: string, file: File): Promise<void> {
	const target = safeJoin(root, relative);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const buffer = Buffer.from(await file.arrayBuffer());
	await fs.writeFile(target, buffer);
}

export async function directorySize(dir: string): Promise<number> {
	let total = 0;
	async function walk(current: string) {
		let entries;
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) await walk(full);
			else {
				try {
					total += (await fs.stat(full)).size;
				} catch {
					/* raced with a delete */
				}
			}
		}
	}
	await walk(dir);
	return total;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / Math.pow(1024, i);
	return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
