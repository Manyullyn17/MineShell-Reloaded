import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listTasks } from '#lib/server/tasks.js';
import { guardStream, seesTask } from '#lib/server/access.js';
import { bus } from '#lib/server/events.js';
import { withoutAllowed } from '#lib/server/downloadaccess.js';

/**
 * Push task progress so the Activity page does not have to poll. `brief=1`
 * leaves out the logs: the notification center on every page only needs
 * progress, and a 300-mod install logs a line per mod.
 */
export const GET: RequestHandler = async ({ locals, url, cookies }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const brief = url.searchParams.get('brief') === '1';
	// Only this account's servers' tasks (and, for global admins, those of no server); a stream re-reads it on changes.
	let visible = seesTask(locals.access);
	const tasks = () => (brief ? listTasks().filter(visible).map(({ log: _, ...task }) => task) : listTasks().filter(visible)).map(withoutAllowed);

	if (url.searchParams.get('stream') !== '1') {
		return Response.json({ tasks: tasks() });
	}

	let unsubscribe: (() => void) | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	let stopGuard: (() => void) | null = null;
	const cleanup = () => {
		unsubscribe?.();
		if (heartbeat) clearInterval(heartbeat);
		stopGuard?.();
	};

	const stream = new ReadableStream({
		start(controller) {
			// Which tasks show follows access changes; signed out or disabled, the stream closes.
			stopGuard = guardStream(
				{ locals, cookies },
				(access) => {
					visible = seesTask(access);
					return true;
				},
				() => {
					cleanup();
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				}
			);
			const encoder = new TextEncoder();
			const push = () => {
				try {
					controller.enqueue(
						encoder.encode(`event: tasks\ndata: ${JSON.stringify(tasks())}\n\n`)
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
