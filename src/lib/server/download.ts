import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { addressKind, BlockedDownloadError, isAllowedAddress, refuse } from './downloadaccess';
import { copyFromEarlierDownload, recordDownload } from './filecache';
import { outboundFetch } from './outbound';

export { BlockedDownloadError };

/** Small wrappers around fetch that every provider and installer shares. */

export const USER_AGENT = 'MineShell/0.1 (self-hosted Minecraft server manager)';

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const res = await outboundFetch(url, {
		...init,
		headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }
	});
	if (!res.ok) {
		throw new Error(`${url} returned ${res.status} ${res.statusText}`);
	}
	return (await res.json()) as T;
}

export async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
	const res = await outboundFetch(url, {
		...init,
		headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }
	});
	if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`);
	return res.text();
}

export type DownloadOptions = {
	/** Expected digest; the file is deleted and the call throws when it disagrees. */
	hash?: { algo: 'sha1' | 'sha256' | 'sha512' | 'md5'; value: string } | null;
	onProgress?: (received: number, total: number | null) => void;
};

/**
 * Refuses a URL that is not http(s) or whose host is, or resolves to, a
 * non-public address that has not been allowed (downloadaccess.ts).
 * Download URLs come from pack files that anyone allowed to create a server
 * can upload, so without this they could make MineShell fetch from services
 * that only listen locally.
 */
export async function assertPublicUrl(url: string): Promise<void> {
	const parsed = new URL(url);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new BlockedDownloadError(`Refused to download ${url}: only http and https links are allowed.`);
	}
	const host = parsed.hostname.replace(/^\[|\]$/g, '');
	const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
	for (const address of addresses) {
		const kind = addressKind(address);
		if (kind && !isAllowedAddress(address)) throw refuse(url, { host, address, kind });
	}
}

/** Fetches a download, checking every redirect hop with assertPublicUrl. */
async function fetchPublic(url: string): Promise<Response> {
	let current = url;
	for (let hop = 0; hop <= 10; hop++) {
		await assertPublicUrl(current);
		const res = await outboundFetch(current, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' });
		const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
		if (!location) return res;
		await res.body?.cancel();
		current = new URL(location, current).href;
	}
	throw new Error(`Download failed for ${url}: too many redirects.`);
}

export async function downloadFile(
	url: string,
	destination: string,
	opts: DownloadOptions = {}
): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const temp = `${destination}.part`;
	// The same content downloaded before, still where it was put: copied, not fetched (filecache.ts).
	if (opts.hash && (await copyFromEarlierDownload(opts.hash, temp, destination))) {
		await fs.rename(temp, destination);
		await recordDownload(destination, opts.hash);
		const size = (await fs.stat(destination)).size;
		opts.onProgress?.(size, size);
		return;
	}
	const res = await fetchPublic(url);
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
	if (opts.hash) await recordDownload(destination, opts.hash);
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
