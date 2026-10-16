import net from 'node:net';
import { db } from './db';
import { serverInstances } from './db/schema';

/**
 * Port picking is deliberately dumb: take everything already claimed in the DB,
 * skip it, then confirm the candidate is actually bindable. That catches both
 * MineShell instances and unrelated services on the same box.
 */

export const DEFAULT_SERVER_PORT = 25565;
/**
 * RCON ports live 1000 above game ports (25565 -> 26565), so a server's pair
 * is easy to tell apart and a row of game ports never runs into them. They
 * started at 25575 before October 2026: the eleventh game port took the
 * first RCON port. Not higher: Linux hands out 32768-60999 to outgoing
 * connections, which could be holding the port when a server starts.
 * Existing servers keep what they have.
 */
export const RCON_OFFSET = 1000;
export const DEFAULT_RCON_PORT = DEFAULT_SERVER_PORT + RCON_OFFSET;

/**
 * Every port a server has, whether it runs or not: game and RCON, and the
 * ports its mods are given (Simple Voice Chat's UDP port, a map mod's web
 * server). Only game and RCON counted before October 2026, so a new server
 * could be given a stopped server's voice chat port. Imported when needed:
 * voicechat and worldmap reach back into much of MineShell.
 */
export async function claimedPorts(excludeInstanceId?: string): Promise<Set<number>> {
	const claimed = new Set<number>();
	const { voiceChat } = await import('./voicechat');
	const { getMapSettings } = await import('./worldmap');
	for (const row of db.select().from(serverInstances).all()) {
		if (row.id === excludeInstanceId) continue;
		claimed.add(row.serverPort);
		claimed.add(row.rconPort);
		const voice = await voiceChat(row).catch(() => null);
		if (voice) claimed.add(voice.port);
		const map = getMapSettings(row.id).modPort;
		if (map) claimed.add(map);
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
	const claimed = await claimedPorts(excludeInstanceId);
	for (let port = start; port < start + 500; port++) {
		if (claimed.has(port)) continue;
		if (await portIsFree(port)) return port;
	}
	throw new Error(`No free port found in the range ${start}-${start + 500}.`);
}

export async function allocatePortPair(excludeInstanceId?: string) {
	const serverPort = await allocatePort(DEFAULT_SERVER_PORT, excludeInstanceId);
	return { serverPort, rconPort: await rconPortFor(serverPort, excludeInstanceId) };
}

/** The game port + 1000 if it is free, else the next free one from there (never the game port itself). */
export async function rconPortFor(serverPort: number, excludeInstanceId?: string): Promise<number> {
	const start = serverPort + RCON_OFFSET <= 32767 ? serverPort + RCON_OFFSET : DEFAULT_RCON_PORT;
	const port = await allocatePort(start, excludeInstanceId);
	return port === serverPort ? allocatePort(port + 1, excludeInstanceId) : port;
}

export type PortUser = { instanceId: string; name: string; kind: 'game' | 'rcon' };

/** The other MineShell server using `port`, and for what. */
export function portUser(port: number, excludeInstanceId?: string): PortUser | null {
	for (const row of db.select().from(serverInstances).all()) {
		if (row.id === excludeInstanceId) continue;
		if (row.serverPort === port) return { instanceId: row.id, name: row.name, kind: 'game' };
		if (row.rconPort === port) return { instanceId: row.id, name: row.name, kind: 'rcon' };
	}
	return null;
}

/** Used by settings validation to explain a clash instead of silently failing. */
export function portConflict(port: number, excludeInstanceId?: string): string | null {
	const user = portUser(port, excludeInstanceId);
	if (!user) return null;
	return `${user.name} already uses port ${port} for ${user.kind === 'game' ? 'Minecraft' : 'RCON'}.`;
}
