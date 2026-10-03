import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkServerIcon } from './servericon';

/** A minimal valid PNG of the given size (one grey row, repeated). */
function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	const raw = Buffer.alloc((width + 1) * height, 0x80);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

describe('checkServerIcon', () => {
	it('takes a 64x64 PNG', () => {
		expect(checkServerIcon(png(64, 64))).toBeNull();
	});

	it('names the size of one that is not 64x64', () => {
		expect(checkServerIcon(png(128, 128))).toMatch(/this one is 128x128/);
	});

	it('refuses anything that is not a PNG', () => {
		expect(checkServerIcon(Buffer.from('GIF89a................'))).toMatch(/must be a PNG/);
		expect(checkServerIcon(Buffer.alloc(0))).toMatch(/must be a PNG/);
	});
});
