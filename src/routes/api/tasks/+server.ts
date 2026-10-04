import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listTasks } from '#lib/server/tasks.js';
import { bus } from '#lib/server/events.js';

/** Push task progress so the Activity page does not have to poll. */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');

	if (url.searchParams.get('stream') !== '1') {
		return Response.json({ tasks: listTasks() });
	}

	let unsubscribe: (() => void) | null = null;
	let heartbeat: NodeJS.Timeout | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const push = () => {
				try {
					controller.enqueue(
						encoder.encode(`event: tasks\ndata: ${JSON.stringify(listTasks())}\n\n`)
					);
				} catch {
					/* client gone */
				}
			};
			push();
			unsubscribe = bus.subscribe('task:update', push);
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					/* ignore */
				}
			}, 25_000);
		},
		cancel() {
			unsubscribe?.();
			if (heartbeat) clearInterval(heartbeat);
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
