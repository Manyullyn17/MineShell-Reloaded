import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { audit, getInstance } from '#lib/server/instances.js';
import { checkServerIcon } from '#lib/server/servericon.js';

const ICON = 'server-icon.png';

function instanceOr404(id: string) {
	const instance = getInstance(id);
	if (!instance) error(404, 'No server with that name.');
	return instance;
}

/** The icon players see in their server list. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = instanceOr404(params.id);
	const bytes = await fs.readFile(path.join(instance.path, ICON)).catch(() => null);
	if (!bytes) error(404, 'No icon.');
	return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
};

/** Raw PNG body; the page scales whatever was picked to 64x64 first. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = instanceOr404(params.id);
	const bytes = Buffer.from(await request.arrayBuffer());
	const problem = checkServerIcon(bytes);
	if (problem) return Response.json({ message: problem }, { status: 400 });
	await fs.writeFile(path.join(instance.path, ICON), bytes);
	audit('instance.icon_changed', { instanceId: instance.id });
	return Response.json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = instanceOr404(params.id);
	await fs.rm(path.join(instance.path, ICON), { force: true });
	audit('instance.icon_removed', { instanceId: instance.id });
	return Response.json({ ok: true });
};
