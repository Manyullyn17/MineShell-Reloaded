import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { fetchJson } from './download';
import { rconPassword } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { patchProperties, readProperties } from './properties';

/**
 * Player lists live in JSON files next to the world. When the server is running
 * those files are owned by the JVM, so edits go over RCON and the server writes
 * them itself. When it is stopped, MineShell edits the files directly. Same UI
 * either way.
 */

/**
 * One row of any list. `key` identifies it for removal: a player name, or the
 * address for IP bans.
 */
export type PlayerEntry = {
	key: string;
	name: string;
	uuid: string | null;
	/** Operators. */
	level?: number;
	bypassesPlayerLimit?: boolean;
	/** Bans. */
	reason?: string;
	created?: string;
	source?: string;
	expires?: string;
};

type WhitelistFile = { uuid: string; name: string }[];
type OpsFile = { uuid: string; name: string; level: number; bypassesPlayerLimit: boolean }[];
type BanFields = { created?: string; source?: string; expires?: string; reason?: string };
type BansFile = ({ uuid: string; name: string } & BanFields)[];
type IpBansFile = ({ ip: string } & BanFields)[];

export type PlayerLists = {
	whitelist: PlayerEntry[];
	ops: PlayerEntry[];
	bans: PlayerEntry[];
	ipBans: PlayerEntry[];
	whitelistEnforced: boolean;
	/** The level `op` gives while the server runs (server.properties op-permission-level). */
	defaultOpLevel: number;
	serverRunning: boolean;
};

const banFields = (e: BanFields) => ({ reason: e.reason, created: e.created, source: e.source, expires: e.expires });

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as T;
	} catch {
		return fallback;
	}
}

async function writeJsonFile(file: string, data: unknown): Promise<void> {
	await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function loadPlayerLists(instance: ServerInstance): Promise<PlayerLists> {
	const dir = instance.path;
	const [whitelist, ops, bans, ipBans, props, state] = await Promise.all([
		readJsonFile<WhitelistFile>(path.join(dir, FILES.whitelist), []),
		readJsonFile<OpsFile>(path.join(dir, FILES.ops), []),
		readJsonFile<BansFile>(path.join(dir, FILES.bans), []),
		readJsonFile<IpBansFile>(path.join(dir, FILES.ipBans), []),
		readProperties(dir),
		unitState(instance.id)
	]);

	return {
		whitelist: whitelist.map((e) => ({ key: e.name, name: e.name, uuid: e.uuid })),
		ops: ops.map((e) => ({
			key: e.name,
			name: e.name,
			uuid: e.uuid,
			level: e.level,
			bypassesPlayerLimit: e.bypassesPlayerLimit
		})),
		bans: bans.map((e) => ({ key: e.name, name: e.name, uuid: e.uuid, ...banFields(e) })),
		ipBans: ipBans.map((e) => ({ key: e.ip, name: e.ip, uuid: null, ...banFields(e) })),
		whitelistEnforced: props.values['white-list'] === 'true',
		defaultOpLevel: opLevel(props.values['op-permission-level']) ?? 4,
		serverRunning: state.active === 'active'
	};
}

const uuidCache = new Map<string, { uuid: string; name: string }>();

/** Mojang's profile endpoint, cached in memory for the process lifetime. */
export async function resolveProfile(name: string): Promise<{ uuid: string; name: string } | null> {
	const key = name.toLowerCase();
	const cached = uuidCache.get(key);
	if (cached) return cached;
	try {
		const data = await fetchJson<{ id: string; name: string }>(
			`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`
		);
		const dashed = data.id.replace(
			/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
			'$1-$2-$3-$4-$5'
		);
		const profile = { uuid: dashed, name: data.name };
		uuidCache.set(key, profile);
		return profile;
	} catch {
		return null;
	}
}

export type ListName = 'whitelist' | 'ops' | 'bans' | 'ipBans';

const FILES: Record<ListName, string> = {
	whitelist: 'whitelist.json',
	ops: 'ops.json',
	bans: 'banned-players.json',
	ipBans: 'banned-ips.json'
};

export const DEFAULT_BAN_REASON = 'Banned by an operator.';

/** Vanilla's own command arguments: the reason is the rest of the line. */
const RCON_ADD: Record<ListName, (key: string, reason: string) => string> = {
	whitelist: (n) => `whitelist add ${n}`,
	ops: (n) => `op ${n}`,
	bans: (n, reason) => `ban ${n} ${reason}`.trim(),
	ipBans: (n, reason) => `ban-ip ${n} ${reason}`.trim()
};

const RCON_REMOVE: Record<ListName, (key: string) => string> = {
	whitelist: (n) => `whitelist remove ${n}`,
	ops: (n) => `deop ${n}`,
	bans: (n) => `pardon ${n}`,
	ipBans: (ip) => `pardon-ip ${ip}`
};

/** Java names are 3-16 of [A-Za-z0-9_]; Geyser/Floodgate prefixes Bedrock names (".Steve"). */
const PLAYER_NAME = /^[.*]?[A-Za-z0-9_]{1,16}$/;

function opLevel(value: unknown): number | null {
	const level = Number(value);
	return Number.isInteger(level) && level >= 1 && level <= 4 ? level : null;
}

/** "2026-10-04 20:15:00 +0200": what vanilla writes and parses; anything else it reads as "now". */
export function banDate(date: Date): string {
	const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
	const offset = -date.getTimezoneOffset();
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
		`${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}${pad(offset % 60)}`
	);
}

async function viaRcon(instance: ServerInstance, command: string): Promise<string | null> {
	const password = rconPassword(instance);
	if (!password) return null;
	const state = await unitState(instance.id);
	if (state.active !== 'active') return null;
	try {
		const [response] = await rconExec({ port: instance.rconPort, password }, [command]);
		return response;
	} catch {
		return null;
	}
}

/** RCON answers in the server's colours. */
const plain = (text: string) => text.replace(/§./g, '').trim();

/**
 * Vanilla's refusals ("Invalid IP address or unknown player", "That player does
 * not exist", "Nothing changed. The player is already whitelisted", ...). RCON
 * itself succeeds either way, so the answer is all there is to go by.
 */
const REFUSED = /^(invalid|nothing changed|that player does not exist|no player was found|unknown|could not|player is already|incorrect argument)/i;

function rconResult(answer: string, fallback: string): { ok: boolean; message: string } {
	const message = plain(answer);
	return { ok: !REFUSED.test(message), message: message || fallback };
}

export type AddOptions = { reason?: string; level?: number };

export async function addPlayer(
	instance: ServerInstance,
	list: ListName,
	name: string,
	opts: AddOptions = {}
): Promise<{ ok: boolean; message: string }> {
	const trimmed = name.trim();
	if (!trimmed) return { ok: false, message: list === 'ipBans' ? 'Enter an IP address or a player name.' : 'Enter a player name.' };
	const isIp = net.isIP(trimmed) !== 0;
	if (!(list === 'ipBans' && isIp) && !PLAYER_NAME.test(trimmed)) {
		return { ok: false, message: `"${trimmed}" is not a valid player name${list === 'ipBans' ? ' or IP address' : ''}.` };
	}
	const reason = (opts.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

	const live = await viaRcon(instance, RCON_ADD[list](trimmed, reason));
	if (live !== null) return rconResult(live, `Added ${trimmed}.`);

	const file = path.join(instance.path, FILES[list]);
	const ban = { created: banDate(new Date()), source: 'MineShell', expires: 'forever', reason: reason || DEFAULT_BAN_REASON };

	if (list === 'ipBans') {
		if (!isIp) {
			return {
				ok: false,
				message: "The server is stopped, so it does not know this player's address. Ban an IP address, or start the server and ban them while they are online."
			};
		}
		const existing = await readJsonFile<IpBansFile>(file, []);
		if (existing.some((e) => e.ip === trimmed)) return { ok: false, message: `${trimmed} is already banned.` };
		await writeJsonFile(file, [...existing, { ip: trimmed, ...ban }]);
		return { ok: true, message: `Banned ${trimmed}.` };
	}

	const profile = await resolveProfile(trimmed);
	if (!profile) {
		return {
			ok: false,
			message: `Mojang has no account called "${trimmed}". Check the spelling, or start the server and add them while it is running.`
		};
	}

	const existing = await readJsonFile<Record<string, unknown>[]>(file, []);
	if (existing.some((e) => String(e.uuid) === profile.uuid)) {
		return { ok: false, message: `${profile.name} is already on that list.` };
	}

	const entry: Record<string, unknown> =
		list === 'ops'
			? { uuid: profile.uuid, name: profile.name, level: opLevel(opts.level) ?? 4, bypassesPlayerLimit: false }
			: list === 'bans'
				? { uuid: profile.uuid, name: profile.name, ...ban }
				: { uuid: profile.uuid, name: profile.name };

	await writeJsonFile(file, [...existing, entry]);
	return { ok: true, message: `Added ${profile.name}.` };
}

export async function removePlayer(
	instance: ServerInstance,
	list: ListName,
	key: string
): Promise<{ ok: boolean; message: string }> {
	const live = await viaRcon(instance, RCON_REMOVE[list](key));
	if (live !== null) return rconResult(live, `Removed ${key}.`);

	const file = path.join(instance.path, FILES[list]);
	const existing = await readJsonFile<Record<string, unknown>[]>(file, []);
	const field = list === 'ipBans' ? 'ip' : 'name';
	const filtered = existing.filter((e) => String(e[field]).toLowerCase() !== key.toLowerCase());
	await writeJsonFile(file, filtered);
	return { ok: true, message: `Removed ${key}.` };
}

/**
 * An operator's level and player-limit bypass. Vanilla has no command for
 * either and keeps ops.json in memory, so this only works while it is stopped.
 */
export async function setOpOptions(
	instance: ServerInstance,
	name: string,
	opts: { level: number; bypassesPlayerLimit: boolean }
): Promise<{ ok: boolean; message: string }> {
	if ((await unitState(instance.id)).active === 'active') {
		return { ok: false, message: 'Stop the server first: it keeps the operator list in memory and would overwrite the change.' };
	}
	const level = opLevel(opts.level);
	if (!level) return { ok: false, message: 'Pick a level from 1 to 4.' };
	const file = path.join(instance.path, FILES.ops);
	const ops = await readJsonFile<OpsFile>(file, []);
	const op = ops.find((e) => e.name.toLowerCase() === name.toLowerCase());
	if (!op) return { ok: false, message: `${name} is not an operator.` };
	op.level = level;
	op.bypassesPlayerLimit = opts.bypassesPlayerLimit;
	await writeJsonFile(file, ops);
	return { ok: true, message: `${op.name} is now a level ${level} operator.` };
}

export async function setWhitelistEnforced(
	instance: ServerInstance,
	enabled: boolean
): Promise<void> {
	await patchProperties(instance.path, { 'white-list': enabled ? 'true' : 'false' });
	await viaRcon(instance, enabled ? 'whitelist on' : 'whitelist off');
}

export async function kickPlayer(instance: ServerInstance, name: string, reason: string) {
	return viaRcon(instance, `kick ${name} ${reason}`.trim());
}
