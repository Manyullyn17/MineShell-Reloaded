import net from 'node:net';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { serverInstances, settings } from './db/schema';

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

/**
 * Where new ports are looked for, per kind (MineShell settings > Ports):
 * the first game port, how far above its game port a server's RCON port
 * sits, and the first voice chat and map mod ports. Only new ports follow
 * a change; servers keep the ones they have.
 */
export type PortRanges = { game: number; rconOffset: number; voice: number; map: number };
export const DEFAULT_PORT_RANGES: PortRanges = { game: DEFAULT_SERVER_PORT, rconOffset: RCON_OFFSET, voice: 24454, map: 8123 };
const RANGES_KEY = 'ports.ranges';
/** Linux's ports for outgoing connections (net.ipv4.ip_local_port_range). */
export const EPHEMERAL = [32768, 60999] as const;

/** Why these ranges cannot be saved, or null. */
export function portRangesProblem(r: PortRanges): string | null {
	for (const [key, label] of [['game', 'Game'], ['voice', 'Voice chat'], ['map', 'Map mod']] as const) {
		if (!Number.isInteger(r[key]) || r[key] < 1024 || r[key] > 65535) return `${label} ports start between 1024 and 65535.`;
	}
	if (!Number.isInteger(r.rconOffset) || r.rconOffset < 1 || r.rconOffset > 30000) return 'RCON ports sit 1 to 30000 above the game port.';
	if (r.game + r.rconOffset > 65535) return 'The first game port plus the RCON distance has to stay below 65536.';
	return null;
}

export function portRanges(): PortRanges {
	const raw = db.select().from(settings).where(eq(settings.key, RANGES_KEY)).get()?.value;
	try {
		const ranges = { ...DEFAULT_PORT_RANGES, ...(raw ? (JSON.parse(raw) as Partial<PortRanges>) : {}) };
		return portRangesProblem(ranges) ? { ...DEFAULT_PORT_RANGES } : ranges;
	} catch {
		return { ...DEFAULT_PORT_RANGES };
	}
}

export function savePortRanges(r: PortRanges): void {
	const value = JSON.stringify(r);
	db.insert(settings).values({ key: RANGES_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/**
 * Where a server's RCON port is looked for: the distance above its game
 * port, or above the first game port when that would run into Linux's
 * outgoing ports (or past 65535) where the first one does not.
 */
export function rconStart(serverPort: number, r: PortRanges = portRanges()): number {
	const limit = r.game + r.rconOffset < EPHEMERAL[0] ? EPHEMERAL[0] - 1 : 65535;
	return serverPort + r.rconOffset <= limit ? serverPort + r.rconOffset : r.game + r.rconOffset;
}

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
	const serverPort = await allocatePort(portRanges().game, excludeInstanceId);
	return { serverPort, rconPort: await rconPortFor(serverPort, excludeInstanceId) };
}

/** The game port + the RCON distance if it is free, else the next free one from there (never the game port itself). */
export async function rconPortFor(serverPort: number, excludeInstanceId?: string): Promise<number> {
	const start = rconStart(serverPort);
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
