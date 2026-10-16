import path from 'node:path';
import zlib from 'node:zlib';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { compareVersions } from '#lib/server/java.js';
import { itemIconsEnabled, serverResources } from '#lib/server/itemicons.js';
import { blockInfo, legacyBlockIds, regionColumns, type BlockInfo } from '#lib/server/chunkmap.js';
import { regionName } from '#lib/server/regionfile.js';
import { chunkMapFolder } from '#lib/server/world.js';

/**
 * One region of the chunk map: the top block of each of its 512x512 columns
 * with names and colours (lib/shared/chunkmap.ts reads it). Binary, gzipped:
 * a little-endian u32 length, that much JSON (padded to 4 bytes), then the
 * block indices (u16), heights (i16) and water depths (u8), row by row.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const x = Number(url.searchParams.get('x'));
	const z = Number(url.searchParams.get('z'));
	if (!Number.isInteger(x) || !Number.isInteger(z) || Math.abs(x) > 65536 || Math.abs(z) > 65536) error(400, 'Not a region.');
	const folder = await chunkMapFolder(instance, url.searchParams.get('source') ?? 'live', url.searchParams.get('dimension') ?? '');
	if (!folder) error(404, 'No such dimension there.');
	const legacy = compareVersions(instance.minecraftVersion, '1.13') < 0;
	const columns = await regionColumns(instance.id, path.join(folder.base, 'region'), regionName(x, z), legacy ? await legacyBlockIds(folder.worldDir) : null);
	if (!columns) return new Response(null, { status: 204 });
	// Pictures turned off in MineShell's settings: names from the ids, no colours.
	let info: Record<string, BlockInfo> = {};
	let vanilla = false;
	if (itemIconsEnabled()) {
		const res = await serverResources(instance);
		info = await blockInfo(res, columns.keys, !legacy);
		vanilla = res.hasVanilla;
	}
	let json = JSON.stringify({
		blocks: columns.keys.map((key) => ({ key, name: info[key]?.name ?? null, color: info[key]?.color ?? null })),
		unreadable: columns.unreadable,
		vanilla
	});
	json += ' '.repeat((4 - (Buffer.byteLength(json) % 4)) % 4);
	const head = Buffer.alloc(4);
	head.writeUInt32LE(Buffer.byteLength(json));
	const body = Buffer.concat([
		head,
		Buffer.from(json),
		Buffer.from(columns.blocks.buffer, columns.blocks.byteOffset, columns.blocks.byteLength),
		Buffer.from(columns.heights.buffer, columns.heights.byteOffset, columns.heights.byteLength),
		Buffer.from(columns.depths.buffer, columns.depths.byteOffset, columns.depths.byteLength)
	]);
	return new Response(zlib.gzipSync(body, { level: 4 }), {
		headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' }
	});
};
