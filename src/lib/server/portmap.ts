import fs from 'node:fs/promises';
import type { ServerInstance } from './db/schema';
import { db } from './db';
import { serverInstances } from './db/schema';
import { eq } from 'drizzle-orm';
import { UNIT_PREFIX } from './config';
import { audit, getInstance, InstanceError, listInstances, syncPortsToProperties } from './instances';
import { claimedPorts, portIsFree, portRanges, rconStart, type PortRanges } from './ports';
import { readProperties } from './properties';
import { unitState } from './systemd';
import { setVoiceConfig, udpPortIsFree, voiceChat } from './voicechat';
import { getMapSettings, saveMapSettings } from './worldmap';
import { PORT_KIND_LABELS, type PortKind } from '#lib/shared/ports.js';

/**
 * Every port the servers have, next to what listens on this machine
 * (MineShell settings > Ports): game, RCON, query (the game port's number
 * over UDP, when enabled), Simple Voice Chat's UDP port and a map mod's web
 * server. Two servers with one port are a clash; a port something else
 * holds keeps that server from starting.
 */

export type { PortKind };
export type Protocol = 'tcp' | 'udp';

export type PortEntry = {
	instanceId: string;
	name: string;
	kind: PortKind;
	port: number;
	protocol: Protocol;
	/** Set when the port is the game port's number and moves with it (query; voice chat's port=-1). */
	followsGame: boolean;
};

/** Each server's ports, as configured (a running server can still be on its old ones). */
export async function serverPorts(instances: ServerInstance[] = listInstances()): Promise<PortEntry[]> {
	const entries: PortEntry[] = [];
	for (const instance of instances) {
		const own = (kind: PortKind, port: number, protocol: Protocol, followsGame = false) =>
			entries.push({ instanceId: instance.id, name: instance.name, kind, port, protocol, followsGame });
		own('game', instance.serverPort, 'tcp');
		own('rcon', instance.rconPort, 'tcp');
		if ((await readProperties(instance.path)).values['enable-query'] === 'true') own('query', instance.serverPort, 'udp', true);
		const voice = await voiceChat(instance).catch(() => null);
		if (voice) own('voice', voice.port, 'udp', voice.port === instance.serverPort);
		const map = getMapSettings(instance.id).modPort;
		if (map) own('map', map, 'tcp');
	}
	return entries;
}

// ---------------------------------------------------------------- listeners ---

export type Listener = { port: number; protocol: Protocol; inode: number };

/**
 * Listening sockets from /proc/net/{tcp,udp}[6]: TCP in LISTEN (0A), UDP
 * bound and unconnected (07). Ports are hex after the address's colon.
 */
export function parseNetTable(text: string, protocol: Protocol): Listener[] {
	const out: Listener[] = [];
	for (const line of text.split('\n').slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 10) continue;
		if (f[3] !== (protocol === 'tcp' ? '0A' : '07')) continue;
		const port = parseInt(f[1].split(':').pop() ?? '', 16);
		const inode = Number(f[9]);
		if (Number.isInteger(port) && port > 0 && inode > 0) out.push({ port, protocol, inode });
	}
	return out;
}

export type Holder = {
	pid: number | null;
	/** The program (`comm`), null when the process is another account's. */
	process: string | null;
	/** The systemd unit it runs in, from its cgroup. */
	unit: string | null;
	/** The MineShell server whose unit it is. */
	instanceId: string | null;
};

/** The unit at the end of a /proc/<pid>/cgroup line, and the server it belongs to. */
export function unitOf(cgroup: string): { unit: string | null; instanceId: string | null } {
	const unit = cgroup.trim().split('/').reverse().find((part) => /\.(service|scope)$/.test(part)) ?? null;
	const ours = unit?.match(new RegExp(`^${UNIT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@(.+)\\.service$`));
	return { unit, instanceId: ours ? ours[1] : null };
}

/**
 * Who holds each listening port. Sockets are matched to processes by inode
 * through /proc/<pid>/fd, which only shows this account's processes; others'
 * sockets are listed without a process.
 */
export async function listeners(): Promise<(Listener & { holder: Holder })[]> {
	const sockets: Listener[] = [];
	for (const [file, protocol] of [['tcp', 'tcp'], ['tcp6', 'tcp'], ['udp', 'udp'], ['udp6', 'udp']] as const) {
		const text = await fs.readFile(`/proc/net/${file}`, 'utf8').catch(() => '');
		sockets.push(...parseNetTable(text, protocol));
	}
	const wanted = new Set(sockets.map((s) => s.inode));
	const byInode = new Map<number, Holder>();
	for (const name of await fs.readdir('/proc').catch(() => [] as string[])) {
		if (!/^\d+$/.test(name)) continue;
		const fds = await fs.readdir(`/proc/${name}/fd`).catch(() => null);
		if (!fds) continue;
		let holder: Holder | null = null;
		for (const fd of fds) {
			const link = await fs.readlink(`/proc/${name}/fd/${fd}`).catch(() => '');
			const inode = Number(link.match(/^socket:\[(\d+)\]$/)?.[1]);
			if (!wanted.has(inode)) continue;
			holder ??= {
				pid: Number(name),
				process: (await fs.readFile(`/proc/${name}/comm`, 'utf8').catch(() => '')).trim() || null,
				...unitOf(await fs.readFile(`/proc/${name}/cgroup`, 'utf8').catch(() => ''))
			};
			byInode.set(inode, holder);
		}
	}
	// One row per port and protocol (IPv4 and IPv6 sockets of one program).
	const seen = new Set<string>();
	const out: (Listener & { holder: Holder })[] = [];
	for (const s of sockets) {
		const key = `${s.protocol}:${s.port}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ ...s, holder: byInode.get(s.inode) ?? { pid: null, process: null, unit: null, instanceId: null } });
	}
	return out;
}

// ----------------------------------------------------------------- overview ---

export type PortStatus =
	/** Its own server listens on it. */
	| 'listening'
	/** Nothing holds it. */
	| 'free'
	/** Something else listens on it: the server cannot start, or not get this port. */
	| 'taken';

export type PortRow = PortEntry & {
	running: boolean;
	status: PortStatus;
	holder: Holder | null;
	/** Other servers' ports with the same number and protocol. */
	clashes: { instanceId: string; name: string; kind: PortKind }[];
};

/** Where servers' ports are given out from, and a margin: other programs here are worth showing. */
const near = (r: PortRanges) => [
	[r.map, r.map + 500],
	[r.voice, r.voice + 1000],
	[r.game, r.game + 1000],
	[r.game + r.rconOffset, r.game + r.rconOffset + 1000]
];

export type PortOverview = {
	rows: PortRow[];
	/** Listeners that are none of the servers' configured ports: near their ranges, or a server's old port. */
	others: { port: number; protocol: Protocol; holder: Holder; oldPortOf: string | null }[];
};

export function buildOverview(entries: PortEntry[], heard: (Listener & { holder: Holder })[], running: Set<string>, names: Map<string, string>): PortOverview {
	const listenerAt = new Map(heard.map((l) => [`${l.protocol}:${l.port}`, l]));
	const rows = entries.map((entry): PortRow => {
		const listener = listenerAt.get(`${entry.protocol}:${entry.port}`);
		const status: PortStatus = !listener ? 'free' : listener.holder.instanceId === entry.instanceId ? 'listening' : 'taken';
		const clashes = entries
			.filter((o) => o !== entry && o.port === entry.port && o.protocol === entry.protocol)
			.map((o) => ({ instanceId: o.instanceId, name: o.name, kind: o.kind }));
		return { ...entry, running: running.has(entry.instanceId), status, holder: status === 'taken' ? listener!.holder : null, clashes };
	});
	const configured = new Set(entries.map((e) => `${e.protocol}:${e.port}`));
	const ranges = near(portRanges());
	const others = heard
		.filter((l) => !configured.has(`${l.protocol}:${l.port}`))
		.filter((l) => l.holder.instanceId || ranges.some(([from, to]) => l.port >= from && l.port <= to))
		.map((l) => ({ port: l.port, protocol: l.protocol, holder: l.holder, oldPortOf: l.holder.instanceId ? (names.get(l.holder.instanceId) ?? l.holder.instanceId) : null }))
		.sort((a, b) => a.port - b.port);
	return { rows: rows.sort((a, b) => a.port - b.port || a.name.localeCompare(b.name)), others };
}

export async function portOverview(): Promise<PortOverview> {
	const instances = listInstances();
	const running = new Set<string>();
	for (const instance of instances) {
		if ((await unitState(instance.id).catch(() => null))?.active === 'active') running.add(instance.id);
	}
	return buildOverview(await serverPorts(instances), await listeners(), running, new Map(instances.map((i) => [i.id, i.name])));
}

// ----------------------------------------------------------------- changing ---

/** The kinds that can be given a port of their own (query and voice port=-1 follow the game port). */
export const MOVABLE: PortKind[] = ['game', 'rcon', 'voice', 'map'];

const protocolOf = (kind: PortKind): Protocol => (kind === 'voice' || kind === 'query' ? 'udp' : 'tcp');

/** Why `port` cannot be this server's `kind` port, or null. */
export async function portChangeProblem(instance: ServerInstance, kind: PortKind, port: number): Promise<string | null> {
	if (!MOVABLE.includes(kind)) return 'That port follows the game port; change the game port instead.';
	if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Ports go from 1 to 65535.';
	const entries = await serverPorts();
	const protocol = protocolOf(kind);
	const clash = entries.find((e) => e.port === port && e.protocol === protocol && !(e.instanceId === instance.id && e.kind === kind));
	if (clash) {
		return clash.instanceId === instance.id
			? `That is this server's ${PORT_KIND_LABELS[clash.kind]} port.`
			: `${clash.name} uses port ${port} for ${PORT_KIND_LABELS[clash.kind]}. Move that one first.`;
	}
	if ((kind === 'game' && port === instance.rconPort) || (kind === 'rcon' && port === instance.serverPort)) return 'The game port and RCON port must differ.';
	return null;
}

/**
 * The first port for `kind` no server has (any kind) and nothing on the
 * machine holds, from where that kind's ports start.
 */
export async function freePortFor(instance: ServerInstance, kind: PortKind): Promise<number> {
	const claimed = await claimedPorts(instance.id);
	const voice = await voiceChat(instance).catch(() => null);
	const own = new Set([instance.serverPort, instance.rconPort, voice?.port, getMapSettings(instance.id).modPort].filter((p): p is number => !!p));
	const r = portRanges();
	const start = { game: r.game, rcon: rconStart(instance.serverPort, r), voice: r.voice, map: r.map, query: r.game }[kind];
	const free = protocolOf(kind) === 'udp' ? udpPortIsFree : portIsFree;
	for (let port = start; port < start + 1000 && port <= 65535; port++) {
		if (claimed.has(port) || own.has(port)) continue;
		if (await free(port)) return port;
	}
	throw new InstanceError(`No free port found from ${start}.`);
}

/** Gives the server's `kind` port the new number, where that port is configured. Applies from its next start. */
export async function setServerPort(instance: ServerInstance, kind: PortKind, port: number): Promise<void> {
	const problem = await portChangeProblem(instance, kind, port);
	if (problem) throw new InstanceError(problem);
	let from: number | null = null;
	if (kind === 'game' || kind === 'rcon') {
		from = kind === 'game' ? instance.serverPort : instance.rconPort;
		db.update(serverInstances)
			.set({ ...(kind === 'game' ? { serverPort: port } : { rconPort: port }), updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		await syncPortsToProperties(getInstance(instance.id)!);
	} else if (kind === 'voice') {
		from = (await voiceChat(instance))?.port ?? null;
		await setVoiceConfig(instance, { port });
	} else {
		from = getMapSettings(instance.id).modPort;
		saveMapSettings(instance.id, { modPort: port });
	}
	audit('instance.port_changed', { instanceId: instance.id, detail: `${kind} ${from ?? '-'} -> ${port}` });
}
