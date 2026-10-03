import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

/**
 * The server's own log files - crash-reports/*.txt and logs/* (latest.log,
 * the rotated .log.gz, debug.log) - which outlast the journal's retention.
 */

const gunzip = promisify(zlib.gunzip);

export type LogFile = { path: string; folder: 'crash-reports' | 'logs'; name: string; size: number; modifiedAt: number };

const FOLDERS = ['crash-reports', 'logs'] as const;

/** What is shown of one file: the end of a big one, which is where a crash is. */
export const SHOWN_BYTES = 2 * 1024 * 1024;
/** A .gz is unpacked up to this much; beyond it only its end is shown anyway. */
const MAX_UNPACKED = 64 * 1024 * 1024;

export async function listLogFiles(root: string): Promise<LogFile[]> {
	const found: LogFile[] = [];
	for (const folder of FOLDERS) {
		for (const entry of await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])) {
			if (!entry.isFile() || !/\.(txt|log|log\.gz)$/.test(entry.name)) continue;
			const stat = await fs.stat(path.join(root, folder, entry.name)).catch(() => null);
			if (stat) found.push({ path: `${folder}/${entry.name}`, folder, name: entry.name, size: stat.size, modifiedAt: stat.mtimeMs });
		}
	}
	return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Only `crash-reports/<file>` and `logs/<file>`, nothing deeper or elsewhere. */
export function isLogPath(relative: string): boolean {
	const [folder, name, ...rest] = relative.split('/');
	return (FOLDERS as readonly string[]).includes(folder) && !!name && rest.length === 0 && name !== '..' && name !== '.';
}

export async function readLogFile(root: string, relative: string): Promise<{ text: string; truncated: boolean } | null> {
	if (!isLogPath(relative)) return null;
	const file = path.join(root, relative);
	const stat = await fs.stat(file).catch(() => null);
	if (!stat?.isFile()) return null;

	let bytes: Buffer;
	if (relative.endsWith('.gz')) {
		try {
			bytes = await gunzip(await fs.readFile(file), { maxOutputLength: MAX_UNPACKED });
		} catch {
			return { text: 'This archive could not be unpacked (damaged, or bigger than 64 MB unpacked).', truncated: false };
		}
	} else {
		const start = Math.max(0, stat.size - SHOWN_BYTES);
		const handle = await fs.open(file, 'r');
		try {
			bytes = Buffer.alloc(stat.size - start);
			await handle.read(bytes, 0, bytes.length, start);
		} finally {
			await handle.close();
		}
		if (start > 0) return { text: dropPartialLine(bytes.toString('utf8')), truncated: true };
	}
	if (bytes.length > SHOWN_BYTES) return { text: dropPartialLine(bytes.subarray(bytes.length - SHOWN_BYTES).toString('utf8')), truncated: true };
	return { text: bytes.toString('utf8'), truncated: false };
}

/** A cut taken from the middle of a file starts mid-line. */
function dropPartialLine(text: string): string {
	const nl = text.indexOf('\n');
	return nl >= 0 ? text.slice(nl + 1) : text;
}
