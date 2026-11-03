import fs from 'node:fs/promises';

/**
 * CurseForge's file fingerprint, what its fingerprint lookup takes: MurmurHash2 (32 bit,
 * seed 1) of the file with every tab, line feed, carriage return and space byte left out.
 * Checked against the `fileFingerprint` CurseForge lists for real jars
 * (curseforge-fingerprint.test.ts).
 */
export function curseforgeFingerprint(data: Uint8Array): number {
	const bytes = new Uint8Array(data.length);
	let length = 0;
	for (const b of data) if (b !== 9 && b !== 10 && b !== 13 && b !== 32) bytes[length++] = b;

	const m = 0x5bd1e995;
	let h = (1 ^ length) >>> 0;
	let i = 0;
	for (; i + 4 <= length; i += 4) {
		let k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
		k = Math.imul(k, m);
		k ^= k >>> 24;
		k = Math.imul(k, m);
		h = Math.imul(h, m) ^ k;
	}
	switch (length - i) {
		case 3:
			h ^= bytes[i + 2] << 16;
		// falls through
		case 2:
			h ^= bytes[i + 1] << 8;
		// falls through
		case 1:
			h ^= bytes[i];
			h = Math.imul(h, m);
	}
	h ^= h >>> 13;
	h = Math.imul(h, m);
	h ^= h >>> 15;
	return h >>> 0;
}

/** A file's CurseForge fingerprint, or null when it cannot be read. */
export async function fingerprintFile(file: string): Promise<number | null> {
	try {
		return curseforgeFingerprint(await fs.readFile(file));
	} catch {
		return null;
	}
}
