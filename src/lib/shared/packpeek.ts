/**
 * What an uploaded pack targets, read in the browser before it is sent: the
 * Minecraft version and loader from a CurseForge zip's `manifest.json` or a
 * .mrpack's `modrinth.index.json`. Only the zip's directory and that one entry
 * are read, so a 1 GB pack costs a few kilobytes. Anything unexpected (no
 * manifest, Zip64, an unknown compression) answers null: the form then simply
 * does not know, and the server still reads the pack itself on install.
 */

export type PackTarget = { minecraft: string | null; loader: string | null };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MANIFESTS = ['manifest.json', 'modrinth.index.json'];

async function bytes(file: Blob, start: number, end: number): Promise<DataView> {
	return new DataView(await file.slice(start, end).arrayBuffer());
}

async function inflate(data: ArrayBuffer): Promise<ArrayBuffer> {
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	return new Response(stream).arrayBuffer();
}

/** The zip entry at the archive's root named `name`, as text; null when there is none. */
async function readEntry(file: Blob, names: string[]): Promise<{ name: string; text: string } | null> {
	// The end record sits in the last 22 bytes plus a comment of up to 64 KB.
	const tailStart = Math.max(0, file.size - 22 - 0xffff);
	const tail = await bytes(file, tailStart, file.size);
	let eocd = -1;
	for (let i = tail.byteLength - 22; i >= 0; i--) {
		if (tail.getUint32(i, true) === EOCD) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return null;
	const size = tail.getUint32(eocd + 12, true);
	const offset = tail.getUint32(eocd + 16, true);
	if (offset === 0xffffffff || offset + size > file.size) return null;

	const dir = await bytes(file, offset, offset + size);
	const decoder = new TextDecoder();
	for (let p = 0; p + 46 <= dir.byteLength && dir.getUint32(p, true) === CENTRAL; ) {
		const method = dir.getUint16(p + 10, true);
		const compressed = dir.getUint32(p + 20, true);
		const nameLength = dir.getUint16(p + 28, true);
		const extraLength = dir.getUint16(p + 30, true);
		const commentLength = dir.getUint16(p + 32, true);
		const local = dir.getUint32(p + 42, true);
		const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength));
		p += 46 + nameLength + extraLength + commentLength;
		if (!names.includes(name)) continue;

		const header = await bytes(file, local, local + 30);
		if (header.getUint32(0, true) !== LOCAL) return null;
		const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
		const raw = await file.slice(start, start + compressed).arrayBuffer();
		if (method === 0) return { name, text: decoder.decode(raw) };
		if (method === 8) return { name, text: decoder.decode(await inflate(raw)) };
		return null;
	}
	return null;
}

export async function peekPack(file: Blob): Promise<PackTarget | null> {
	try {
		const entry = await readEntry(file, MANIFESTS);
		if (!entry) return null;
		const json = JSON.parse(entry.text);
		if (entry.name === 'manifest.json') {
			// CurseForge: modLoaders ids like "forge-14.23.5.2860"; the primary one first.
			const loaders: { id?: string; primary?: boolean }[] = json?.minecraft?.modLoaders ?? [];
			const id = (loaders.find((l) => l.primary) ?? loaders[0])?.id ?? '';
			return { minecraft: json?.minecraft?.version ?? null, loader: id.split('-')[0] || null };
		}
		const deps: Record<string, string> = json?.dependencies ?? {};
		const loader = ['forge', 'neoforge', 'fabric-loader', 'quilt-loader'].find((l) => l in deps);
		return { minecraft: deps.minecraft ?? null, loader: loader?.replace('-loader', '') ?? null };
	} catch {
		return null;
	}
}
