import zlib from 'node:zlib';

/**
 * A PNG decoder for textures, to RGBA (no image library needed): every
 * colour type, bit depths 1-16, palettes with tRNS. Interlaced files
 * (Adam7) are refused: textures are not saved that way.
 */

export type Rgba = { width: number; height: number; data: Uint8Array };

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(bytes: Buffer): Rgba | null {
	if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return null;
	let width = 0;
	let height = 0;
	let depth = 0;
	let type = 0;
	let palette: Buffer | null = null;
	let alpha: Buffer | null = null;
	const idat: Buffer[] = [];
	for (let at = 8; at + 8 <= bytes.length; ) {
		const length = bytes.readUInt32BE(at);
		const name = bytes.toString('ascii', at + 4, at + 8);
		const body = bytes.subarray(at + 8, at + 8 + length);
		if (name === 'IHDR') {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8];
			type = body[9];
			if (body[12] !== 0) return null;
		} else if (name === 'PLTE') palette = body;
		else if (name === 'tRNS') alpha = body;
		else if (name === 'IDAT') idat.push(body);
		else if (name === 'IEND') break;
		at += 12 + length;
	}
	const channels = CHANNELS[type];
	if (!channels || !width || !height || width * height > 4096 * 4096) return null;
	let raw: Buffer;
	try {
		raw = zlib.inflateSync(Buffer.concat(idat));
	} catch {
		return null;
	}
	const bitsPerPixel = channels * depth;
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	const step = Math.max(1, bitsPerPixel >> 3);
	if (raw.length < height * (stride + 1)) return null;
	const rows = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const out = rows.subarray(y * stride, (y + 1) * stride);
		const up = y ? rows.subarray((y - 1) * stride, y * stride) : null;
		for (let i = 0; i < stride; i++) {
			const a = i >= step ? out[i - step] : 0;
			const b = up ? up[i] : 0;
			const c = up && i >= step ? up[i - step] : 0;
			let v = line[i];
			if (filter === 1) v += a;
			else if (filter === 2) v += b;
			else if (filter === 3) v += (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			out[i] = v & 0xff;
		}
	}
	const sample = (y: number, n: number): number => {
		// The n-th sample of a row, scaled to 8 bits.
		if (depth === 8) return rows[y * stride + n];
		if (depth === 16) return rows[y * stride + n * 2];
		const bit = n * depth;
		const v = (rows[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
		return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
	};
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			const s = x * channels;
			if (type === 3) {
				const i = sample(y, x);
				data[o] = palette?.[i * 3] ?? 0;
				data[o + 1] = palette?.[i * 3 + 1] ?? 0;
				data[o + 2] = palette?.[i * 3 + 2] ?? 0;
				data[o + 3] = alpha && i < alpha.length ? alpha[i] : 255;
			} else if (type === 0 || type === 4) {
				const g = sample(y, s);
				data[o] = data[o + 1] = data[o + 2] = g;
				data[o + 3] = type === 4 ? sample(y, s + 1) : 255;
			} else {
				data[o] = sample(y, s);
				data[o + 1] = sample(y, s + 1);
				data[o + 2] = sample(y, s + 2);
				data[o + 3] = type === 6 ? sample(y, s + 3) : 255;
			}
		}
	}
	return { width, height, data };
}
