import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Players every new server starts with on its whitelist and as operators (New server
 * defaults): whoever runs MineShell adds themselves to each test server otherwise. Kept
 * with the Mojang account's UUID, looked up when the defaults are saved, so adding a
 * server asks Mojang nothing; written into whitelist.json and ops.json at creation, as
 * the Players tab writes them for a stopped server.
 */

export type DefaultPlayer = { name: string; uuid: string };
export type DefaultPlayers = { whitelist: DefaultPlayer[]; ops: DefaultPlayer[] };

export const NO_DEFAULT_PLAYERS: DefaultPlayers = { whitelist: [], ops: [] };

/** Java names are 3-16 of [A-Za-z0-9_] (players.ts PLAYER_NAME without Bedrock's prefixes). */
export const JAVA_NAME = /^[A-Za-z0-9_]{1,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_DEFAULT_PLAYERS = 50;

function cleanList(input: unknown): DefaultPlayer[] {
	if (!Array.isArray(input)) return [];
	const out: DefaultPlayer[] = [];
	for (const entry of input) {
		const name = (entry as DefaultPlayer)?.name;
		const uuid = (entry as DefaultPlayer)?.uuid;
		if (typeof name !== 'string' || !JAVA_NAME.test(name) || typeof uuid !== 'string' || !UUID.test(uuid)) continue;
		if (out.some((p) => p.uuid === uuid)) continue;
		out.push({ name, uuid });
	}
	return out.slice(0, MAX_DEFAULT_PLAYERS);
}

export function cleanDefaultPlayers(input: unknown): DefaultPlayers {
	const stored = input && typeof input === 'object' ? (input as Partial<DefaultPlayers>) : {};
	return { whitelist: cleanList(stored.whitelist), ops: cleanList(stored.ops) };
}

/** The names typed in a box: one per line, or separated by commas or spaces. */
export function namesFromText(text: string): string[] {
	const names: string[] = [];
	for (const name of text.split(/[\s,;]+/).filter(Boolean)) {
		if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
	}
	return names;
}

/**
 * The UUID an offline-mode server gives a name: version 3 from "OfflinePlayer:<name>", as
 * Java's UUID.nameUUIDFromBytes makes it. Such a server matches its lists by this, not by
 * the Mojang account's.
 */
export function offlineUuid(name: string): string {
	const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x30;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readList(file: string): Promise<Record<string, unknown>[]> {
	try {
		const list = JSON.parse(await fs.readFile(file, 'utf8'));
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}

/**
 * Adds the default players to a new server's whitelist.json and ops.json, keeping whatever
 * is there already. `properties` are the server.properties it was given: offline mode gets
 * offline UUIDs, operators get its op-permission-level.
 */
export async function writeDefaultPlayers(dir: string, players: DefaultPlayers, properties: Record<string, string>): Promise<void> {
	const offline = properties['online-mode'] === 'false';
	const uuidOf = (p: DefaultPlayer) => (offline ? offlineUuid(p.name) : p.uuid);
	const level = Number(properties['op-permission-level']);
	const opLevel = Number.isInteger(level) && level >= 1 && level <= 4 ? level : 4;
	const lists: [string, DefaultPlayer[], (p: DefaultPlayer) => Record<string, unknown>][] = [
		['whitelist.json', players.whitelist, (p) => ({ uuid: uuidOf(p), name: p.name })],
		['ops.json', players.ops, (p) => ({ uuid: uuidOf(p), name: p.name, level: opLevel, bypassesPlayerLimit: false })]
	];
	for (const [name, wanted, entry] of lists) {
		if (!wanted.length) continue;
		const file = path.join(dir, name);
		const existing = await readList(file);
		const added = wanted.filter((p) => !existing.some((e) => String(e.uuid) === uuidOf(p))).map(entry);
		if (added.length) await fs.writeFile(file, JSON.stringify([...existing, ...added], null, 2) + '\n', 'utf8');
	}
}
