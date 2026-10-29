import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { checkModUpdates } from '#lib/server/modupdates.js';

/**
 * Which mods have a newer version; fetched separately, since a big pack takes
 * a while to check. Answers one JSON object per line: `{ progress }` as the
 * check goes, then `{ result }` or `{ message }` when it failed.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (line: unknown) => {
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
				} catch {
					/* the page went away; the check finishes anyway */
				}
			};
			try {
				send({ result: await checkModUpdates(instance, { onProgress: (progress) => send({ progress }) }) });
			} catch (err) {
				send({ message: err instanceof Error ? err.message : 'Checking for updates failed.' });
			}
			try {
				controller.close();
			} catch {
				/* already closed */
			}
		}
	});
	return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
};
