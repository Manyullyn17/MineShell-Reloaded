import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

/**
 * A fresh empty directory, inside the run's throwaway data directory so it is
 * cleaned up with it (tests/global-setup.ts).
 */
export async function tempDir(prefix = 'case-'): Promise<string> {
	const root = path.join(process.env.MINESHELL_DATA ?? os.tmpdir(), 'cases');
	await fs.mkdir(root, { recursive: true });
	return fs.mkdtemp(path.join(root, prefix));
}

/** Build a zip/jar in memory from { 'path/in/zip': content }. */
export function zipBuffer(files: Record<string, string | Buffer>): Buffer {
	const zip = new AdmZip();
	for (const [name, content] of Object.entries(files)) {
		zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
	}
	return zip.toBuffer();
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
