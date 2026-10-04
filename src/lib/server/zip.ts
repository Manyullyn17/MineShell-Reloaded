import fs from 'node:fs/promises';
import { constants as bufferConstants } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

/**
 * Reads zips - mod jars, pack archives - with node built-ins only, so
 * crashdiag.ts stays runnable outside the app (tests/crashdiag/capture.mjs).
 * Just what MineShell needs: the central directory, and one entry read whole.
 *
 * Archives come from users and pack authors, so nothing in them is trusted:
 * an entry inflates to at most the size the archive declares (a small entry
 * that expands to gigabytes fails instead of filling memory), offsets and
 * lengths are checked against the archive instead of reading past its end,
 * and a name that appears twice resolves to one entry (the last, as unzip
 * leaves it) everywhere. World archives are streamed with yauzl instead.
 */

export type ZipEntry = {
	name: string;
	flags: number;
	method: number;
	compressedSize: number;
	size: number;
	/** Of the entry's local header. */
	offset: number;
};

/** An archive held in memory. */
export type ZipArchive = {
	entries: ZipEntry[];
	read: (entry: ZipEntry) => Buffer;
	/** The file's contents, or null when the archive has no such entry. */
	readFile: (name: string) => Buffer | null;
	readText: (name: string) => string | null;
};

/** An archive on disk; only what is asked for is read. */
export type ZipFile = {
	entries: ZipEntry[];
	read: (entry: ZipEntry) => Promise<Buffer>;
};

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;
/** The end record (22 bytes) plus the longest comment it can carry. */
const TAIL = 22 + 0xffff;

class ZipError extends Error {}

function corrupt(what: string): never {
	throw new ZipError(`Damaged zip archive (${what})`);
}

function u64(buf: Buffer, at: number): number {
	const value = buf.readBigUInt64LE(at);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) corrupt('offset out of range');
	return Number(value);
}

type EndRecord = { offset: number; size: number; zip64At: number | null };

/** From the archive's last bytes; null when there is no end record, i.e. not a zip. */
function findEnd(tail: Buffer): EndRecord | null {
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) !== END || i + 22 + tail.readUInt16LE(i + 20) > tail.length) continue;
		const locator = i - 20;
		return {
			size: tail.readUInt32LE(i + 12),
			offset: tail.readUInt32LE(i + 16),
			zip64At: locator >= 0 && tail.readUInt32LE(locator) === END64_LOCATOR ? u64(tail, locator + 8) : null
		};
	}
	return null;
}

/** The zip64 end record (56 bytes) holds the real directory position. */
function zip64End(record: Buffer): { offset: number; size: number } {
	if (record.length < 56 || record.readUInt32LE(0) !== END64) corrupt('zip64 end record');
	return { size: u64(record, 40), offset: u64(record, 48) };
}

function zip64Extra(cd: Buffer, start: number, length: number, entry: ZipEntry): void {
	for (let p = start; p + 4 <= start + length; ) {
		const id = cd.readUInt16LE(p);
		const size = cd.readUInt16LE(p + 2);
		if (id === 0x0001) {
			// Present only for the fields the central header set to 0xffffffff, in this order.
			let q = p + 4;
			const next = () => {
				if (q + 8 > p + 4 + size) corrupt('zip64 extra field');
				const value = u64(cd, q);
				q += 8;
				return value;
			};
			if (entry.size === MAX32) entry.size = next();
			if (entry.compressedSize === MAX32) entry.compressedSize = next();
			if (entry.offset === MAX32) entry.offset = next();
			return;
		}
		p += 4 + size;
	}
	corrupt('missing zip64 sizes');
}

function parseDirectory(cd: Buffer): ZipEntry[] {
	const byName = new Map<string, ZipEntry>();
	let p = 0;
	while (p + 46 <= cd.length) {
		if (cd.readUInt32LE(p) !== CENTRAL) corrupt('central directory');
		const nameLength = cd.readUInt16LE(p + 28);
		const extraLength = cd.readUInt16LE(p + 30);
		const end = p + 46 + nameLength + extraLength + cd.readUInt16LE(p + 32);
		if (end > cd.length) corrupt('central directory');
		const entry: ZipEntry = {
			name: cd.toString('utf8', p + 46, p + 46 + nameLength),
			flags: cd.readUInt16LE(p + 8),
			method: cd.readUInt16LE(p + 10),
			compressedSize: cd.readUInt32LE(p + 20),
			size: cd.readUInt32LE(p + 24),
			offset: cd.readUInt32LE(p + 42)
		};
		if (entry.size === MAX32 || entry.compressedSize === MAX32 || entry.offset === MAX32) {
			zip64Extra(cd, p + 46 + nameLength, extraLength, entry);
		}
		byName.delete(entry.name);
		byName.set(entry.name, entry);
		p = end;
	}
	return [...byName.values()];
}

/** Where the entry's data starts, from its local header (whose name and extra may differ from the central one's). */
function dataStart(header: Buffer, entry: ZipEntry): number {
	if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) corrupt(`local header of ${entry.name}`);
	return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

function decompress(entry: ZipEntry, data: Buffer): Buffer {
	if (data.length !== entry.compressedSize) corrupt(`${entry.name} is truncated`);
	if (entry.flags & 1) throw new ZipError(`${entry.name} is encrypted`);
	if (entry.method === 0) {
		if (entry.size !== entry.compressedSize) corrupt(`size of ${entry.name}`);
		return data;
	}
	if (entry.method !== 8) throw new ZipError(`${entry.name} uses an unsupported compression method (${entry.method})`);
	try {
		return inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(entry.size, bufferConstants.MAX_LENGTH)) });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') corrupt(`${entry.name} is larger than declared`);
		throw err;
	}
}

function slice(buf: Buffer, start: number, length: number, what: string): Buffer {
	if (start < 0 || start + length > buf.length) corrupt(what);
	return buf.subarray(start, start + length);
}

/** Null when `buf` is not a zip; throws when it is a damaged one. */
export function openZipBuffer(buf: Buffer): ZipArchive | null {
	const end = findEnd(buf.subarray(Math.max(0, buf.length - TAIL)));
	if (!end) return null;
	const where = end.zip64At === null ? end : zip64End(slice(buf, end.zip64At, 56, 'zip64 end record'));
	const entries = parseDirectory(slice(buf, where.offset, where.size, 'central directory'));
	const byName = new Map(entries.map((e) => [e.name, e]));
	const read = (entry: ZipEntry) => {
		const start = dataStart(slice(buf, entry.offset, 30, `local header of ${entry.name}`), entry);
		return decompress(entry, slice(buf, start, entry.compressedSize, `${entry.name} is truncated`));
	};
	const readFile = (name: string) => {
		const entry = byName.get(name);
		return entry ? read(entry) : null;
	};
	return { entries, read, readFile, readText: (name) => readFile(name)?.toString('utf8') ?? null };
}

async function readAt(handle: fs.FileHandle, position: number, length: number, what: string): Promise<Buffer> {
	const buf = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buf, 0, length, position);
	if (bytesRead < length) corrupt(what);
	return buf;
}

/** Reads the central directory only (a few KB, not the whole jar). Null when `file` is not a zip. */
export async function openZipFile(file: string): Promise<ZipFile | null> {
	const handle = await fs.open(file, 'r');
	try {
		const { size } = await handle.stat();
		const tailLength = Math.min(size, TAIL);
		const end = findEnd(await readAt(handle, size - tailLength, tailLength, 'end record'));
		if (!end) return null;
		const where = end.zip64At === null ? end : zip64End(await readAt(handle, end.zip64At, 56, 'zip64 end record'));
		if (where.offset + where.size > size) corrupt('central directory');
		const entries = parseDirectory(await readAt(handle, where.offset, where.size, 'central directory'));
		return {
			entries,
			read: async (entry) => {
				const h = await fs.open(file, 'r');
				try {
					const start = dataStart(await readAt(h, entry.offset, 30, `local header of ${entry.name}`), entry);
					return decompress(entry, await readAt(h, start, entry.compressedSize, `${entry.name} is truncated`));
				} finally {
					await h.close();
				}
			}
		};
	} finally {
		await handle.close();
	}
}

/** The names in a zip's central directory; null when it is not a readable zip. */
export async function zipEntryNames(file: string): Promise<string[] | null> {
	const zip = await openZipFile(file).catch(() => null);
	return zip ? zip.entries.map((e) => e.name) : null;
}
