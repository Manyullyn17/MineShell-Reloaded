import zlib from 'node:zlib';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { pruneAnalysis } from '#lib/server/world.js';
import { encodeAnalysis } from '#lib/shared/chunkprune.js';

/**
 * The last prune analysis of a server (World > Prune chunks): every chunk's
 * InhabitedTime and size, binary and gzipped (encodeAnalysis). 204 when there
 * is none, or it is of another dimension or older than `at`.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const analysis = pruneAnalysis(instance.id);
	if (!analysis || analysis.dimension !== url.searchParams.get('dimension') || String(analysis.at) !== url.searchParams.get('at')) {
		return new Response(null, { status: 204 });
	}
	const { dimension, at, spawn, regions } = analysis;
	const body = encodeAnalysis({ dimension, at, spawn, regions: regions.map((r) => ({ x: r.x, z: r.z })) }, regions);
	return new Response(zlib.gzipSync(body, { level: 4 }), {
		headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' }
	});
};
