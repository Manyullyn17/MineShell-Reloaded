import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { isPath } from '#lib/server/nbtedit.js';
import { NbtEditError, nbtSlice, nbtSnbt, parseNbtEdits, restoreNbtVersion, saveNbtEdits, searchNbt } from '#lib/server/nbtfiles.js';
import type { Path } from '#lib/shared/nbt.js';

/**
 * The NBT editor in Files (nbtfiles.ts). GET: `?q=` searches the file; `?snbt=1&at=` is one
 * entry whole as SNBT; else `?at=&from=&upTo=` are more entries of a list or compound. POST:
 * `{ path, version, edits, refresh }` saves edits, `{ path, version, restore }` puts an earlier
 * version back.
 */

function instanceOf(id: string) {
	const instance = getInstance(id);
	if (!instance) error(404, 'No server with that name.');
	return instance;
}

function pathOf(raw: string | null): Path {
	let at: unknown;
	try {
		at = JSON.parse(raw ?? '[]');
	} catch {
		at = null;
	}
	if (!isPath(at)) error(400, 'That is not a path into the file.');
	return at;
}

async function answer<T>(run: () => Promise<T>): Promise<Response> {
	try {
		return json(await run());
	} catch (err) {
		if (err instanceof NbtEditError) error(400, err.message);
		throw err;
	}
}

export const GET: RequestHandler = async ({ params, url }) => {
	const instance = instanceOf(params.id);
	const file = url.searchParams.get('path') ?? '';
	const query = url.searchParams.get('q');
	if (query !== null) return answer(() => searchNbt(instance, file, query));
	const at = pathOf(url.searchParams.get('at'));
	if (url.searchParams.has('snbt')) return answer(() => nbtSnbt(instance, file, at));
	const from = Number(url.searchParams.get('from') ?? 0);
	const upTo = Number(url.searchParams.get('upTo') ?? 0);
	if (!Number.isInteger(from) || !Number.isInteger(upTo)) error(400, 'Not a position in the file.');
	return answer(() => nbtSlice(instance, file, at, from, upTo));
};

export const POST: RequestHandler = async ({ params, request }) => {
	const instance = instanceOf(params.id);
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.path !== 'string' || typeof body.version !== 'string') error(400, 'That change could not be read.');
	const { path: file, version } = body as { path: string; version: string };
	if (typeof body.restore === 'string') {
		const restore = body.restore;
		return answer(async () => ({ version: await restoreNbtVersion(instance, file, version, restore) }));
	}
	const refresh = body.refresh as { at?: unknown; upTo?: unknown } | null | undefined;
	if (refresh && (!isPath(refresh.at) || !Number.isInteger(refresh.upTo))) error(400, 'That change could not be read.');
	return answer(async () =>
		saveNbtEdits(instance, file, version, parseNbtEdits(body.edits), refresh ? { at: refresh.at as Path, upTo: refresh.upTo as number } : null)
	);
};
