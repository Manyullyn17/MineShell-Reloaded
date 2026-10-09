import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { DISABLED_SUFFIX, modsDir } from './mods';

/**
 * Simple Voice Chat: players' clients connect to it on a UDP port of its own
 * (config/voicechat/voicechat-server.properties, `port`, 24454 by default), not
 * through the game connection. Two servers on one machine with the default
 * both want 24454, and the second stops itself at start ("Failed to run voice
 * chat at UDP port"). So MineShell checks the port before a start, gives new
 * and copied servers a free one, and shows it with the firewall hint;
 * `voice_host` is where clients are sent instead (a playit.gg UDP tunnel).
 */

export const VOICE_CONFIG = path.join('config', 'voicechat', 'voicechat-server.properties');
export const DEFAULT_VOICE_PORT = 24454;

export type VoiceChat = {
	/** The UDP port it listens on (`port=-1` means the game port's number). */
	port: number;
	/** `voice_host`: the address clients are told to use, '' for the server's own. */
	host: string;
};

/** Whether the mod is there: its config (written at its first start) or an enabled jar. */
export async function hasVoiceChat(instance: Pick<ServerInstance, 'path'>): Promise<boolean> {
	if (await fs.access(path.join(instance.path, VOICE_CONFIG)).then(() => true, () => false)) return true;
	const jars = await fs.readdir(modsDir(instance.path)).catch(() => [] as string[]);
	return jars.some((name) => /voicechat/i.test(name) && name.endsWith('.jar') && !name.endsWith(DISABLED_SUFFIX));
}

async function readConfig(instance: Pick<ServerInstance, 'path'>): Promise<string> {
	return fs.readFile(path.join(instance.path, VOICE_CONFIG), 'utf8').catch(() => '');
}

function value(text: string, key: string): string | null {
	const line = text.split('\n').find((l) => l.trim().startsWith(`${key}=`));
	return line === undefined ? null : line.slice(line.indexOf('=') + 1).trim();
}

/** The server's voice chat, or null without the mod. */
export async function voiceChat(instance: Pick<ServerInstance, 'path' | 'serverPort'>): Promise<VoiceChat | null> {
	if (!(await hasVoiceChat(instance))) return null;
	const text = await readConfig(instance);
	const port = Number(value(text, 'port') ?? DEFAULT_VOICE_PORT);
	return {
		port: port === -1 ? instance.serverPort : Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_VOICE_PORT,
		host: value(text, 'voice_host') ?? ''
	};
}

/**
 * Sets keys in the config, keeping every other line as it is. Before the mod's
 * first start there is no file: one with just these keys, which the mod fills
 * in with its defaults.
 */
export async function setVoiceConfig(instance: Pick<ServerInstance, 'path'>, changes: { port?: number; host?: string }): Promise<void> {
	const file = path.join(instance.path, VOICE_CONFIG);
	const lines = (await readConfig(instance)).split('\n');
	if (lines.at(-1) === '') lines.pop();
	for (const [key, raw] of [['port', changes.port], ['voice_host', changes.host]] as const) {
		if (raw === undefined) continue;
		const line = `${key}=${raw}`;
		const at = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
		if (at >= 0) lines[at] = line;
		else lines.push(line);
	}
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${lines.join('\n')}\n`);
}

/** Whether nothing on this machine holds the UDP port. */
export function udpPortIsFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = dgram.createSocket('udp4');
		socket.once('error', () => {
			socket.close();
			resolve(false);
		});
		socket.bind(port, '0.0.0.0', () => socket.close(() => resolve(true)));
	});
}

type Other = Pick<ServerInstance, 'id' | 'name' | 'path' | 'serverPort'>;

/** Other servers' voice chat ports (theirs to use when they run). */
async function otherVoicePorts(instanceId: string, others: Other[]): Promise<Map<number, Other>> {
	const ports = new Map<number, Other>();
	for (const other of others) {
		if (other.id === instanceId) continue;
		const voice = await voiceChat(other);
		if (voice) ports.set(voice.port, other);
	}
	return ports;
}

/**
 * Why the server's voice chat cannot have its port now, or null: another
 * server with the same port is running (named), or something else holds it.
 */
export async function voicePortProblem(
	instance: Pick<ServerInstance, 'id' | 'path' | 'serverPort'>,
	others: Other[],
	running: (id: string) => Promise<boolean>
): Promise<string | null> {
	const voice = await voiceChat(instance);
	// port=-1 shares the game port's number, which the game port check already covers.
	if (!voice || voice.port === instance.serverPort) return null;
	const same = (await otherVoicePorts(instance.id, others)).get(voice.port);
	if (same && (await running(same.id))) {
		return `Voice chat's UDP port ${voice.port} is used by ${same.name}, which is running. Give this server another one in Settings, Network, then try again.`;
	}
	if (!(await udpPortIsFree(voice.port))) {
		return `Voice chat's UDP port ${voice.port} is already in use by something else on this machine. Free it, or give this server another one in Settings, Network, then try again.`;
	}
	return null;
}

/** The first port from 24454 up that no other server's voice chat has and nothing holds. */
export async function freeVoicePort(instanceId: string, others: Other[], from = DEFAULT_VOICE_PORT): Promise<number> {
	const taken = await otherVoicePorts(instanceId, others);
	const game = new Set(others.map((o) => o.serverPort));
	for (let port = from; port < from + 1000; port++) {
		if (!taken.has(port) && !game.has(port) && (await udpPortIsFree(port))) return port;
	}
	throw new Error('No free UDP port for voice chat near 24454.');
}

/**
 * A new or copied server with voice chat: its own port when another server
 * already has the one it would use (a pack's default, or the copy's source's).
 * Returns the port it was given, or null when it keeps its own.
 */
export async function claimVoicePort(instance: Pick<ServerInstance, 'id' | 'path' | 'serverPort'>, others: Other[]): Promise<number | null> {
	const voice = await voiceChat(instance);
	if (!voice || voice.port === instance.serverPort) return null;
	const taken = await otherVoicePorts(instance.id, others);
	if (!taken.has(voice.port) && (await udpPortIsFree(voice.port))) return null;
	const port = await freeVoicePort(instance.id, others);
	await setVoiceConfig(instance, { port });
	return port;
}
