import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { allocatePort, DEFAULT_SERVER_PORT, portIsFree, portUser, RCON_OFFSET } from '#lib/server/ports.js';
import { unitState } from '#lib/server/systemd.js';

/**
 * Whether a port can be given to this server, for the indicator next to the
 * Settings port fields: the MineShell server using it (with where it would
 * go if moved), or something else on the machine listening on it.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const port = Number(url.searchParams.get('port'));
	const field = url.searchParams.get('field') === 'rcon' ? 'rcon' : 'game';
	if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ valid: false });

	const current = field === 'game' ? instance.serverPort : instance.rconPort;
	const other = port === current ? null : portUser(port, instance.id);
	let freeTo: number | null = null;
	if (other) {
		const start = other.kind === 'game' ? DEFAULT_SERVER_PORT : (getInstance(other.instanceId)?.serverPort ?? DEFAULT_SERVER_PORT) + RCON_OFFSET;
		const avoid = new Set([port, instance.serverPort, instance.rconPort]);
		freeTo = await allocatePort(start, other.instanceId).catch(() => null);
		while (freeTo !== null && avoid.has(freeTo)) freeTo = await allocatePort(freeTo + 1, other.instanceId).catch(() => null);
	}
	// This server's own ports are busy while it runs: that is not "something else".
	const own = port === instance.serverPort || port === instance.rconPort;
	const running = (await unitState(instance.id).catch(() => null))?.active === 'active';
	const listening = !other && !(own && running) && !(await portIsFree(port));
	return json({
		valid: true,
		other: other ? { name: other.name, kind: other.kind, swapTo: current, freeTo } : null,
		listening
	});
};
