import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { bus } from '#lib/server/events.js';
import { guardStream } from '#lib/server/access.js';
import { can } from '#lib/shared/access.js';

/** Live CPU/memory push, used by any view that wants a moving number. */
export const GET: RequestHandler = async ({ params, locals, cookies }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');

	let unsubscribeStats: (() => void) | null = null;
	let unsubscribeState: (() => void) | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	let stopGuard: (() => void) | null = null;
	const cleanup = () => {
		unsubscribeStats?.();
		unsubscribeState?.();
		if (heartbeat) clearInterval(heartbeat);
		stopGuard?.();
	};

	const stream = new ReadableStream({
		start(controller) {
			// Closed once the account may no longer see the server.
			stopGuard = guardStream({ locals, cookies }, (access) => can(access, instance.id, 'view'), () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
			const encoder = new TextEncoder();
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					/* client gone */
				}
			};

			unsubscribeStats = bus.subscribe('stats:sample', (payload) => {
				if (payload.instanceId === instance.id) send('sample', payload);
			});
			unsubscribeState = bus.subscribe('instance:state', (payload) => {
				if (payload.instanceId === instance.id) send('state', payload);
			});

			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					/* ignore */
				}
			}, 25_000);
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
