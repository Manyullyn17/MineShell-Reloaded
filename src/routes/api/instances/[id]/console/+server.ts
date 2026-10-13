import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { subscribeConsole, type ConsoleSubscription } from '#lib/server/journal.js';
import { guardStream } from '#lib/server/access.js';
import { can } from '#lib/shared/access.js';

/**
 * Server-Sent Events rather than a WebSocket: SvelteKit serves this from a plain
 * endpoint with no custom HTTP server, so it behaves identically in `vite dev`
 * and behind adapter-node. Console input is a separate POST.
 */
export const GET: RequestHandler = async ({ params, locals, cookies }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');

	let subscription: ConsoleSubscription | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	let stopGuard: (() => void) | null = null;
	const cleanup = () => {
		subscription?.close();
		if (heartbeat) clearInterval(heartbeat);
		stopGuard?.();
	};

	const stream = new ReadableStream({
		start(controller) {
			// Closed once the account may no longer read the console (signed out, disabled, access taken away).
			stopGuard = guardStream({ locals, cookies }, (access) => can(access, instance.id, 'console.read'), () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
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
