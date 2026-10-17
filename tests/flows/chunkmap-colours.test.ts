import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * The chunk map's block colours (chunkmap.ts): a block's top texture,
 * averaged, through jars built here.
 */

const { Resources } = await import('#lib/server/itemicons.js');
const { blockInfo } = await import('#lib/server/chunkmap.js');
const { zipBuffer } = await import('../helpers/fs');

/** A 2x2 PNG of one colour. */
function solid(r: number, g: number, b: number): Buffer {
	const chunk = (name: string, body: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(body.length);
		return Buffer.concat([len, Buffer.from(name), body, Buffer.alloc(4)]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(2, 0);
	ihdr.writeUInt32BE(2, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const row = [0, r, g, b, r, g, b];
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(Buffer.from([...row, ...row]))),
		chunk('IEND', Buffer.alloc(0))
	]);
}

async function jar(files: Record<string, string | Buffer>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.env.MINESHELL_DATA!, 'jars-'));
	const file = path.join(dir, 'mod.jar');
	await fs.writeFile(file, zipBuffer(files));
	return file;
}

describe('chunk map colours', () => {
	it('colours a block by its model top, and a 1.12 mod fluid by the texture named after it', async () => {
		const res = await Resources.load(
			[
				await jar({
					'assets/rocks/blockstates/marble.json': JSON.stringify({ variants: { normal: { model: 'rocks:marble' } } }),
					'assets/rocks/models/block/marble.json': JSON.stringify({ parent: 'block/cube_all', textures: { all: 'rocks:blocks/marble' } }),
					'assets/rocks/textures/blocks/marble.png': solid(200, 200, 210),
					// No blockstate: the mod names these textures in code (AbyssalCraft, BuildCraft).
					'assets/abyssalcraft/textures/blocks/cwater_still.png': solid(7, 209, 231),
					'assets/buildcraftenergy/textures/blocks/fluids/oil_heat_0_still.png': solid(3, 3, 3)
				})
			],
			null
		);
		const info = await blockInfo(res, ['rocks:marble@0', 'abyssalcraft:cwater@0', 'buildcraftenergy:fluid_block_oil_heat_0@0', 'nothing:here@0'], false);
		expect(info['rocks:marble@0'].color).toBe(0xc8c8d2);
		expect(info['abyssalcraft:cwater@0'].color).toBe(0x07d1e7);
		expect(info['buildcraftenergy:fluid_block_oil_heat_0@0'].color).toBe(0x030303);
		expect(info['nothing:here@0'].color).toBeNull();
	});

	it("gives Minecraft's own blocks rough colours when its textures are not there", async () => {
		// No client jar: the server's EULA question is unanswered.
		const res = await Resources.load([], null);
		const info = await blockInfo(res, ['minecraft:grass_block', 'minecraft:oak_leaves', 'minecraft:cherry_leaves', 'minecraft:sand', 'minecraft:red_sand', 'minecraft:water', 'minecraft:stone', 'minecraft:frobnicator'], true);
		expect(info['minecraft:grass_block'].color).toBe(0x476d3e);
		expect(info['minecraft:oak_leaves'].color).toBe(0x2a650e);
		expect(info['minecraft:cherry_leaves'].color).toBe(0xe5adc2);
		expect(info['minecraft:sand'].color).toBe(0xdbcfa3);
		expect(info['minecraft:red_sand'].color).toBe(0xbe6621);
		expect(info['minecraft:water'].color).toBe(0x3f76e4);
		expect(info['minecraft:stone'].color).toBe(0x7e7e7e);
		expect(info['minecraft:frobnicator'].color).toBeNull();
	});
});
