import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { audit, getInstance, sendCommand } from '#lib/server/instances.js';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');

	const body = (await request.json().catch(() => ({}))) as { command?: string };
	const command = (body.command ?? '').trim();
	if (!command) return Response.json({ message: 'Nothing to send.' }, { status: 400 });

	try {
		const response = await sendCommand(instance, command);
		audit('console.command', { instanceId: instance.id, detail: command.slice(0, 200) });
		return Response.json({ response });
	} catch (err) {
		return Response.json(
			{
				message:
					err instanceof Error
						? err.message
						: 'Could not reach the server over RCON. Is it running?'
			},
			{ status: 502 }
		);
	}
};
