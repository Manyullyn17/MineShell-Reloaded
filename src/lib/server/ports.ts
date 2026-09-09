import net from 'node:net';
import { db } from './db';
import { serverInstances } from './db/schema';

/**
 * Port picking is deliberately dumb: take everything already claimed in the DB,
 * skip it, then confirm the candidate is actually bindable. That catches both
 * MineShell instances and unrelated services on the same box.
 */

export const DEFAULT_SERVER_PORT = 25565;
export const DEFAULT_RCON_PORT = 25575;

function claimedPorts(excludeInstanceId?: string): Set<number> {
	const rows = db
		.select({
			id: serverInstances.id,
			serverPort: serverInstances.serverPort,
			rconPort: serverInstances.rconPort
		})
		.from(serverInstances)
		.all();
	const claimed = new Set<number>();
	for (const row of rows) {
		if (row.id === excludeInstanceId) continue;
		claimed.add(row.serverPort);
		claimed.add(row.rconPort);
	}
	return claimed;
}

export function portIsFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => server.close(() => resolve(true)));
		server.listen(port, '0.0.0.0');
	});
}

export async function allocatePort(start: number, excludeInstanceId?: string): Promise<number> {
	const claimed = claimedPorts(excludeInstanceId);
	for (let port = start; port < start + 500; port++) {
		if (claimed.has(port)) continue;
		if (await portIsFree(port)) return port;
	}
	throw new Error(`No free port found in the range ${start}-${start + 500}.`);
}

export async function allocatePortPair(excludeInstanceId?: string) {
	const serverPort = await allocatePort(DEFAULT_SERVER_PORT, excludeInstanceId);
	const rconPort = await allocatePort(DEFAULT_RCON_PORT, excludeInstanceId);
	return { serverPort, rconPort };
}

/** Used by settings validation to explain a clash instead of silently failing. */
export function portConflict(port: number, excludeInstanceId?: string): string | null {
	const rows = db.select().from(serverInstances).all();
	for (const row of rows) {
		if (row.id === excludeInstanceId) continue;
		if (row.serverPort === port) return `${row.name} already uses port ${port} for Minecraft.`;
		if (row.rconPort === port) return `${row.name} already uses port ${port} for RCON.`;
	}
	return null;
}
