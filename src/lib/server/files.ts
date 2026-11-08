import fs from 'node:fs/promises';
import { createReadStream, lstatSync, realpathSync } from 'node:fs';
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

const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

/**
 * Where `file` really is, following every symbolic link on the way; for a path
 * that does not exist yet, its nearest existing folder's real place with the
 * rest added. Null when a link on the way leads nowhere (or loops): writing
 * through a dangling link creates whatever it names.
 */
function realPlace(file: string): string | null {
	const rest: string[] = [];
	let at = file;
	for (;;) {
		try {
			return path.join(realpathSync(at), ...rest);
		} catch {
			// Something is there, yet it cannot be followed: a dangling or looping link.
			try {
				lstatSync(at);
				return null;
			} catch {
				// Not there at all: look one folder up.
			}
			const parent = path.dirname(at);
			if (parent === at) return file;
			rest.unshift(path.basename(at));
			at = parent;
		}
	}
}

/**
 * `relative` inside `root`, refused if it leads out: by `../`, and by symbolic
 * links, which whatever runs in the folder (a server's mods) can make. Without
 * the second check a link such as `logs/latest.log -> ~/.ssh/id_ed25519` would
 * have MineShell read, share, overwrite or delete the file it names, with
 * MineShell's own rights. Links that stay inside the folder still work.
 */
export function safeJoin(root: string, relative: string): string {
	const normalisedRoot = path.resolve(root);
	const target = path.resolve(normalisedRoot, relative.replace(/^[/\\]+/, ''));
	if (!inside(normalisedRoot, target)) throw new PathEscapeError();
	if (target === normalisedRoot) return target;
	const realRoot = realPlace(normalisedRoot) ?? normalisedRoot;
	const real = realPlace(target);
	if (real === null || !inside(realRoot, real)) throw new PathEscapeError();
	return target;
}

/**
 * `relative` inside `root` as a name in its folder, for what acts on the name
 * itself (delete, rename, into the trash and back): only the folders on the way
 * are checked, and a link there is never followed. So a link leading out of the
 * folder can still be removed or renamed, which safeJoin would refuse.
 */
export function safeEntry(root: string, relative: string): string {
	const normalisedRoot = path.resolve(root);
	const target = path.resolve(normalisedRoot, relative.replace(/^[/\\]+/, ''));
	if (!inside(normalisedRoot, target)) throw new PathEscapeError();
	if (target === normalisedRoot) return target;
	safeJoin(normalisedRoot, path.relative(normalisedRoot, path.dirname(target)));
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
	/** Looks like NBT (mightBeNbt): opened in the NBT editor, which checks the whole file. */
	nbt: boolean;
};

const TEXT_EXTENSIONS = new Set([
	'.txt', '.json', '.json5', '.jsonc', '.properties', '.yml', '.yaml', '.toml', '.cfg', '.conf',
	'.ini', '.log', '.md', '.sh', '.env', '.lock', '.snbt', '.mcmeta', '.xml', '.csv', '.js', '.lua',
	// CraftTweaker's scripts (1.12 packs keep much of their recipes and balance there).
	'.zs'
]);

const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/**
 * A Content-Disposition saving as `name`. Plain `filename` is taken as it is
 * (RFC 6266): a percent-encoded name in it is decoded by Chrome, not by every
 * browser (`My%20Server.zip`). `filename*` carries the real name, `filename`
 * a plain one for anything that does not read it.
 */
export function attachment(name: string): string {
	const plain = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/** Names NBT files have (`.dat` is any binary format a mod likes, so the content decides). */
const NBT_NAMES = /\.(dat|dat_old|nbt|schematic|schem|litematic)$/i;

/** Worth offering the NBT editor for: such a name, and gzip's magic or a compound tag first. */
export function mightBeNbt(name: string, head: Buffer): boolean {
	if (!NBT_NAMES.test(name) || head.length < 2) return false;
	return (head[0] === 0x1f && head[1] === 0x8b) || head[0] === 0x0a;
}

/** mightBeNbt on the file's first bytes. */
export async function looksNbt(full: string, name: string): Promise<boolean> {
	if (!NBT_NAMES.test(name)) return false;
	const handle = await fs.open(full, 'r').catch(() => null);
	if (!handle) return false;
	try {
		const head = Buffer.alloc(2);
		const { bytesRead } = await handle.read(head, 0, 2, 0);
		return mightBeNbt(name, head.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

export function looksEditable(name: string, size: number): boolean {
	if (size > MAX_EDIT_BYTES) return false;
	const ext = path.extname(name).toLowerCase();
	if (TEXT_EXTENSIONS.has(ext)) return true;
	return ext === '' && /^(eula|banned-ips|ops|whitelist)$/i.test(path.basename(name));
}

/** What search in files reads: what the editor opens, apart from logs and lock files. */
export function isSearchable(name: string, size: number): boolean {
	const ext = path.extname(name).toLowerCase();
	return looksEditable(name, size) && ext !== '.log' && ext !== '.lock';
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
				editable: !stat.isDirectory() && looksEditable(entry.name, stat.size),
				nbt: stat.isFile() && (await looksNbt(full, entry.name))
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

/**
 * The editor posts a form, and forms send every newline as CRLF: the file keeps
 * the line endings it had (LF when new or without CRLF). Written as posted, a
 * saved run.sh failed on "\r: command not found".
 */
export async function writeTextFile(root: string, relative: string, contents: string): Promise<void> {
	const target = safeJoin(root, relative);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const crlf = await fs.readFile(target, 'utf8').then(
		(old) => old.includes('\r\n'),
		() => false
	);
	const lf = contents.replace(/\r\n/g, '\n');
	await replaceFile(target, crlf ? lf.replace(/\n/g, '\r\n') : lf);
}

/**
 * Writes `data` as a new file renamed over `target`, never into the file that
 * is there: a file can have other names (hard links), and writing into it
 * would change it under every one of them. The old file's permissions carry
 * over, so an executable run.sh stays one; a symbolic link is written through,
 * as it always was.
 */
async function replaceFile(target: string, data: string | Buffer): Promise<void> {
	const old = await fs.lstat(target).catch(() => null);
	if (old?.isSymbolicLink()) return fs.writeFile(target, data);
	const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${Date.now()}.tmp`);
	try {
		await fs.writeFile(temp, data, { flag: 'wx' });
		if (old) await fs.chmod(temp, old.mode & 0o7777);
		await fs.rename(temp, target);
	} catch (err) {
		await fs.rm(temp, { force: true });
		throw err;
	}
}

export function fileStream(root: string, relative: string) {
	return createReadStream(safeJoin(root, relative));
}

export async function statFile(root: string, relative: string) {
	return fs.stat(safeJoin(root, relative));
}

export async function createDirectory(root: string, relative: string): Promise<void> {
	await fs.mkdir(safeJoin(root, relative), { recursive: true });
}

export async function renameEntry(root: string, from: string, to: string): Promise<void> {
	const source = safeEntry(root, from);
	const target = safeEntry(root, to);
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
	await replaceFile(target, buffer);
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
