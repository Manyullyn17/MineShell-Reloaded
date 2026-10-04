import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { subscribeConsole, type ConsoleSubscription } from '#lib/server/journal.js';

/**
 * Server-Sent Events rather than a WebSocket: SvelteKit serves this from a plain
 * endpoint with no custom HTTP server, so it behaves identically in `vite dev`
 * and behind adapter-node. Console input is a separate POST.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');

	let subscription: ConsoleSubscription | null = null;
	let heartbeat: NodeJS.Timeout | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (event: string, data: string) => {
				try {
					// Every newline in the payload needs its own data: prefix.
					const payload = data
						.split('\n')
						.map((chunk) => `data: ${chunk}`)
						.join('\n');
					controller.enqueue(encoder.encode(`event: ${event}\n${payload}\n\n`));
				} catch {
					/* client vanished mid-write */
				}
			};

			subscription = subscribeConsole(
				instance.id,
				instance.consoleBacklogLines,
				instance.createdAt,
				(line) => send('line', line)
			);

			for (const line of subscription.backlog) send('line', line);

			// Proxies drop idle connections; a comment frame every 25s keeps it open.
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					/* ignore */
				}
			}, 25_000);
		},
		cancel() {
			subscription?.close();
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
