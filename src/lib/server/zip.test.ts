import fs from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { describe, expect, it } from 'vitest';
import { openZipBuffer, openZipFile, zipEntryNames } from './zip';
import { tempDir, zipBuffer } from '../../../tests/helpers/fs';

/**
 * The same archive in zip64 form: every central header's sizes and offset
 * moved into a zip64 extra field, and the directory found through a zip64
 * end record - as writers do for big archives (or always, some of them).
 */
function toZip64(zip: Buffer): Buffer {
	const endAt = zip.length - 22;
	const cdSize = zip.readUInt32LE(endAt + 12);
	const cdOffset = zip.readUInt32LE(endAt + 16);
	const centrals: Buffer[] = [];
	for (let p = cdOffset; p < cdOffset + cdSize; ) {
		const nameLength = zip.readUInt16LE(p + 28);
		const header = Buffer.from(zip.subarray(p, p + 46 + nameLength));
		const extra = Buffer.alloc(28);
		extra.writeUInt16LE(0x0001, 0);
		extra.writeUInt16LE(24, 2);
		extra.writeBigUInt64LE(BigInt(header.readUInt32LE(24)), 4);
		extra.writeBigUInt64LE(BigInt(header.readUInt32LE(20)), 12);
		extra.writeBigUInt64LE(BigInt(header.readUInt32LE(42)), 20);
		for (const at of [20, 24, 42]) header.writeUInt32LE(0xffffffff, at);
		header.writeUInt16LE(extra.length, 30);
		header.writeUInt16LE(45, 6);
		centrals.push(header, extra);
		p += 46 + nameLength;
	}
	const directory = Buffer.concat(centrals);
	const count = zip.readUInt16LE(endAt + 10);
	const end64 = Buffer.alloc(56);
	end64.writeUInt32LE(0x06064b50, 0);
	end64.writeBigUInt64LE(44n, 4);
	end64.writeUInt16LE(45, 12);
	end64.writeUInt16LE(45, 14);
	end64.writeBigUInt64LE(BigInt(count), 24);
	end64.writeBigUInt64LE(BigInt(count), 32);
	end64.writeBigUInt64LE(BigInt(directory.length), 40);
	end64.writeBigUInt64LE(BigInt(cdOffset), 48);
	const locator = Buffer.alloc(20);
	locator.writeUInt32LE(0x07064b50, 0);
	locator.writeBigUInt64LE(BigInt(cdOffset + directory.length), 8);
	locator.writeUInt32LE(1, 16);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0xffff, 8);
	end.writeUInt16LE(0xffff, 10);
	end.writeUInt32LE(0xffffffff, 12);
	end.writeUInt32LE(0xffffffff, 16);
	return Buffer.concat([zip.subarray(0, cdOffset), directory, end64, locator, end]);
}

function yauzlNames(buf: Buffer): Promise<string[]> {
	return new Promise((resolve, reject) =>
		yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
			if (err) return reject(err);
			const names: string[] = [];
			zip.on('entry', (e: yauzl.Entry) => (names.push(e.fileName), zip.readEntry()));
			zip.on('end', () => resolve(names));
			zip.on('error', reject);
			zip.readEntry();
		})
	);
}

const files = { 'a.txt': 'alpha', 'dir/b.json': '{"b":1}', 'big.bin': Buffer.alloc(100_000, 7) };

describe('zip reading', () => {
	it('lists and reads entries, from memory and from disk', async () => {
		const buf = zipBuffer(files);
		const zip = openZipBuffer(buf)!;
		expect(zip.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.json', 'big.bin']);
		expect(zip.readText('dir/b.json')).toBe('{"b":1}');
		expect(zip.readFile('big.bin')!.equals(files['big.bin'])).toBe(true);
		expect(zip.readFile('missing')).toBeNull();

		const file = path.join(await tempDir(), 'x.jar');
		await fs.writeFile(file, buf);
		const onDisk = (await openZipFile(file))!;
		expect((await onDisk.read(onDisk.entries[0])).toString()).toBe('alpha');
		expect(await zipEntryNames(file)).toEqual(['a.txt', 'dir/b.json', 'big.bin']);
	});

	it('reads zip64 archives', async () => {
		const buf = toZip64(zipBuffer(files));
		// The fixture is a valid zip64 archive by an independent reader's account.
		expect(await yauzlNames(buf)).toEqual(['a.txt', 'dir/b.json', 'big.bin']);
		const zip = openZipBuffer(buf)!;
		expect(zip.readText('a.txt')).toBe('alpha');
		expect(zip.readFile('big.bin')!.length).toBe(100_000);

		const file = path.join(await tempDir(), 'x64.zip');
		await fs.writeFile(file, buf);
		const onDisk = (await openZipFile(file))!;
		expect((await onDisk.read(onDisk.entries[1])).toString()).toBe('{"b":1}');
	});

	it('is not fooled by a trailing comment', () => {
		const buf = zipBuffer({ 'a.txt': 'alpha' });
		const comment = Buffer.from('PK\x05\x06 looks like an end record');
		const withComment = Buffer.concat([buf, comment]);
		withComment.writeUInt16LE(comment.length, buf.length - 2);
		expect(openZipBuffer(withComment)!.readText('a.txt')).toBe('alpha');
	});

	it('returns null for something that is not a zip', async () => {
		expect(openZipBuffer(Buffer.from('just text'))).toBeNull();
		expect(openZipBuffer(Buffer.alloc(0))).toBeNull();
		const file = path.join(await tempDir(), 'not.zip');
		await fs.writeFile(file, 'just text');
		expect(await openZipFile(file)).toBeNull();
		expect(await zipEntryNames(file)).toBeNull();
	});

	it('refuses an entry that inflates past its declared size', () => {
		// 1 MB of zeros deflates to about 1 KB; the header claims 10 bytes.
		const buf = zipBuffer({ 'bomb.bin': Buffer.alloc(1_000_000) });
		const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
		buf.writeUInt32LE(10, cdOffset + 24);
		expect(() => openZipBuffer(buf)!.readFile('bomb.bin')).toThrow(/larger than declared/);
	});

	it('refuses offsets and sizes that point outside the archive', () => {
		const buf = zipBuffer({ 'a.txt': 'alpha' });
		const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
		const grown = Buffer.from(buf);
		grown.writeUInt32LE(0x7fffffff, cdOffset + 20);
		expect(() => openZipBuffer(grown)!.readFile('a.txt')).toThrow(/Damaged zip/);
		const moved = Buffer.from(buf);
		moved.writeUInt32LE(buf.length + 100, buf.length - 22 + 16);
		expect(() => openZipBuffer(moved)).toThrow(/Damaged zip/);
	});

	it('resolves a name that appears twice to one entry, the last', () => {
		const buf = zipBuffer({ 'a.txt': 'first', 'b.txt': 'b' });
		// Rename b.txt to a.txt in its central header; both now claim the name.
		const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
		const second = buf.indexOf('b.txt', cdOffset);
		buf.write('a.txt', second);
		const zip = openZipBuffer(buf)!;
		expect(zip.entries.map((e) => e.name)).toEqual(['a.txt']);
		expect(zip.readText('a.txt')).toBe('b');
	});

	it('reads stored entries and refuses unknown methods', () => {
		const buf = zipBuffer({ 'a.txt': 'alpha' }, { store: true });
		expect(openZipBuffer(buf)!.readText('a.txt')).toBe('alpha');
		const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
		buf.writeUInt16LE(14, cdOffset + 10); // LZMA
		expect(() => openZipBuffer(buf)!.readFile('a.txt')).toThrow(/unsupported compression method/);
	});
});
