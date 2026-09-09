import fs from 'node:fs/promises';
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

export type PlayerEntry = { uuid: string; name: string; extra?: Record<string, unknown> };

type WhitelistFile = { uuid: string; name: string }[];
type OpsFile = { uuid: string; name: string; level: number; bypassesPlayerLimit: boolean }[];
type BansFile = { uuid: string; name: string; created?: string; source?: string; expires?: string; reason?: string }[];

export type PlayerLists = {
	whitelist: PlayerEntry[];
	ops: PlayerEntry[];
	bans: PlayerEntry[];
	whitelistEnforced: boolean;
	serverRunning: boolean;
};

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
	const [whitelist, ops, bans, props, state] = await Promise.all([
		readJsonFile<WhitelistFile>(path.join(dir, 'whitelist.json'), []),
		readJsonFile<OpsFile>(path.join(dir, 'ops.json'), []),
		readJsonFile<BansFile>(path.join(dir, 'banned-players.json'), []),
		readProperties(dir),
		unitState(instance.id)
	]);

	return {
		whitelist: whitelist.map((e) => ({ uuid: e.uuid, name: e.name })),
		ops: ops.map((e) => ({ uuid: e.uuid, name: e.name, extra: { level: e.level } })),
		bans: bans.map((e) => ({ uuid: e.uuid, name: e.name, extra: { reason: e.reason } })),
		whitelistEnforced: props.values['white-list'] === 'true',
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

export type ListName = 'whitelist' | 'ops' | 'bans';

const FILES: Record<ListName, string> = {
	whitelist: 'whitelist.json',
	ops: 'ops.json',
	bans: 'banned-players.json'
};

const RCON_ADD: Record<ListName, (name: string) => string> = {
	whitelist: (n) => `whitelist add ${n}`,
	ops: (n) => `op ${n}`,
	bans: (n) => `ban ${n}`
};

const RCON_REMOVE: Record<ListName, (name: string) => string> = {
	whitelist: (n) => `whitelist remove ${n}`,
	ops: (n) => `deop ${n}`,
	bans: (n) => `pardon ${n}`
};

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

export async function addPlayer(
	instance: ServerInstance,
	list: ListName,
	name: string
): Promise<{ ok: boolean; message: string }> {
	const trimmed = name.trim();
	if (!trimmed) return { ok: false, message: 'Enter a player name.' };

	const live = await viaRcon(instance, RCON_ADD[list](trimmed));
	if (live !== null) return { ok: true, message: live.trim() || `Added ${trimmed}.` };

	const profile = await resolveProfile(trimmed);
	if (!profile) {
		return {
			ok: false,
			message: `Mojang has no account called "${trimmed}". Check the spelling, or start the server and add them while it is running.`
		};
	}

	const file = path.join(instance.path, FILES[list]);
	const existing = await readJsonFile<Record<string, unknown>[]>(file, []);
	if (existing.some((e) => String(e.uuid) === profile.uuid)) {
		return { ok: false, message: `${profile.name} is already on that list.` };
	}

	const entry: Record<string, unknown> =
		list === 'ops'
			? { uuid: profile.uuid, name: profile.name, level: 4, bypassesPlayerLimit: false }
			: list === 'bans'
				? {
						uuid: profile.uuid,
						name: profile.name,
						created: new Date().toISOString(),
						source: 'MineShell',
						expires: 'forever',
						reason: 'Banned by an operator.'
					}
				: { uuid: profile.uuid, name: profile.name };

	await writeJsonFile(file, [...existing, entry]);
	return { ok: true, message: `Added ${profile.name}.` };
}

export async function removePlayer(
	instance: ServerInstance,
	list: ListName,
	name: string
): Promise<{ ok: boolean; message: string }> {
	const live = await viaRcon(instance, RCON_REMOVE[list](name));
	if (live !== null) return { ok: true, message: live.trim() || `Removed ${name}.` };

	const file = path.join(instance.path, FILES[list]);
	const existing = await readJsonFile<Record<string, unknown>[]>(file, []);
	const filtered = existing.filter(
		(e) => String(e.name).toLowerCase() !== name.toLowerCase()
	);
	await writeJsonFile(file, filtered);
	return { ok: true, message: `Removed ${name}.` };
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
