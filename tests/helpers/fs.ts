import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A fresh empty directory, inside the run's throwaway data directory so it is
 * cleaned up with it (tests/global-setup.ts).
 */
export async function tempDir(prefix = 'case-'): Promise<string> {
	const root = path.join(process.env.MINESHELL_DATA ?? os.tmpdir(), 'cases');
	await fs.mkdir(root, { recursive: true });
	return fs.mkdtemp(path.join(root, prefix));
}

/** Build a zip/jar in memory from { 'path/in/zip': content }; entries are deflated unless `store`. */
export function zipBuffer(files: Record<string, string | Buffer>, { store = false } = {}): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
		const packed = store ? data : deflateRawSync(data);
		const nameBytes = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(store ? 0 : 8, 8);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		local.copy(central, 6, 4, 30); // version needed .. name length: same fields
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, packed);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + packed.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(centrals.length / 2, 8);
	end.writeUInt16LE(centrals.length / 2, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

/** Write a jar into `dir` and return its path. */
export async function writeJar(dir: string, name: string, files: Record<string, string | Buffer>): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	await fs.writeFile(file, zipBuffer(files));
	return file;
}

/** A Forge 1.12-style mcmod.info. */
export function mcmodInfo(modid: string, name: string): string {
	return JSON.stringify([{ modid, name, version: '1.0', mcversion: '1.12.2' }]);
}

/** List a directory, sorted, or [] if it does not exist. */
export async function ls(dir: string): Promise<string[]> {
	return (await fs.readdir(dir).catch(() => [] as string[])).sort();
}
