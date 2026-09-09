import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import path from 'node:path';

/** Small wrappers around fetch that every provider and installer shares. */

const USER_AGENT = 'MineShell/0.1 (self-hosted Minecraft server manager)';

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(url, {
		...init,
		headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }
	});
	if (!res.ok) {
		throw new Error(`${url} returned ${res.status} ${res.statusText}`);
	}
	return (await res.json()) as T;
}

export async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
	const res = await fetch(url, {
		...init,
		headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }
	});
	if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`);
	return res.text();
}

export type DownloadOptions = {
	/** Expected digest; the file is deleted and the call throws when it disagrees. */
	hash?: { algo: 'sha1' | 'sha512' | 'md5'; value: string } | null;
	onProgress?: (received: number, total: number | null) => void;
};

export async function downloadFile(
	url: string,
	destination: string,
	opts: DownloadOptions = {}
): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok || !res.body) {
		throw new Error(`Download failed (${res.status}) for ${url}`);
	}

	const total = Number(res.headers.get('content-length')) || null;
	let received = 0;
	const hasher = opts.hash ? crypto.createHash(opts.hash.algo) : null;

	const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
	source.on('data', (chunk: Buffer) => {
		received += chunk.length;
		hasher?.update(chunk);
		opts.onProgress?.(received, total);
	});

	const temp = `${destination}.part`;
	await pipeline(source, createWriteStream(temp));

	if (opts.hash && hasher) {
		const actual = hasher.digest('hex');
		if (actual.toLowerCase() !== opts.hash.value.toLowerCase()) {
			await fs.rm(temp, { force: true });
			throw new Error(
				`Checksum mismatch for ${path.basename(destination)}. Expected ${opts.hash.value.slice(0, 12)}..., got ${actual.slice(0, 12)}...`
			);
		}
	}

	await fs.rename(temp, destination);
}

export async function hashFile(
	filePath: string,
	algo: 'sha1' | 'sha512' = 'sha512'
): Promise<string> {
	const hasher = crypto.createHash(algo);
	const handle = await fs.open(filePath, 'r');
	try {
		const stream = handle.createReadStream();
		for await (const chunk of stream) hasher.update(chunk as Buffer);
	} finally {
		await handle.close();
	}
	return hasher.digest('hex');
}
