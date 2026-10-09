import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq, like } from 'drizzle-orm';
import { DATA_DIR, UNIT_PREFIX, systemdUnitDir } from './config';
import { db } from './db/index';
import { serverInstances, settings, type ServerInstance } from './db/schema';
import { downloadFile } from './download';
import { readProperties } from './properties';
import { run, systemctl } from './systemd';
import { setVoiceConfig, voiceChat } from './voicechat';

/**
 * playit.gg tunnels: players reach a server without port forwarding.
 *
 * One playit agent per machine (a user unit next to the servers) holds an
 * outbound connection to playit; each tunnel names this agent and a local
 * address, and the agent forwards to it. MineShell links the agent by
 * playit's claim flow (the user approves it on playit.gg; no password or
 * account key passes through MineShell), then creates, moves and deletes a
 * tunnel per public server with the agent's key. Settled on a free account
 * (ROADMAP, "playit.gg tunnels"): the agent key may create tunnels once the
 * agent program has connected; regions other than global need Premium; the
 * address players type is a hostname on the default port.
 */

export const API = 'https://api.playit.gg';
/** The agent release MineShell runs: the one the API was tried with. */
export const AGENT_VERSION = '1.0.12';
/** Release files per architecture, with GitHub's SHA-256 digests. */
export const AGENT_BINARIES: Record<string, { file: string; sha256: string }> = {
	x64: { file: 'playit-linux-amd64', sha256: '4ad5aa85670e056b2d2f5f47f9f992b81db34bedc89bbe755c6f8cc0c8206c78' },
	arm64: { file: 'playit-linux-aarch64', sha256: '01ed32ab8f9bd15120a9adfbba866346687f7874398023458f8035997bd4e617' },
	arm: { file: 'playit-linux-armv7', sha256: '6b9e02ef92cebff5220cd7293cc3b807de8b32e6de66c5781d873025dc13514b' },
	ia32: { file: 'playit-linux-i686', sha256: '1e1311b31f09f0456aff463f2badc7b3d368e5a5ea1936224e92ff3cd57290d0' }
};

export const PLAYIT_DIR = path.join(DATA_DIR, 'playit');
const KEY_FILE = path.join(PLAYIT_DIR, 'agent.key');
const agentBinary = () => path.join(PLAYIT_DIR, `playit-${AGENT_VERSION}`);
export const AGENT_UNIT = `${UNIT_PREFIX}-playit.service`;

/** Tunnel regions: global on every plan, the rest need playit Premium. */
export const REGIONS: { id: string; label: string; premium: boolean }[] = [
	{ id: 'global', label: 'Global (nearest to each player)', premium: false },
	{ id: 'north-america', label: 'North America', premium: true },
	{ id: 'europe', label: 'Europe', premium: true },
	{ id: 'asia', label: 'Asia', premium: true },
	{ id: 'india', label: 'India', premium: true },
	{ id: 'south-america', label: 'South America', premium: true }
];

export class PlayitError extends Error {}

// ---------------------------------------------------------------------- api ---

type ApiAnswer<T> = { ok: true; data: T } | { ok: false; error: string };

/** One API call: a POST with JSON, the answer wrapped in {status, data}. */
export async function playitApi<T>(route: string, body: unknown, key?: string | null): Promise<ApiAnswer<T>> {
	let res: Response;
	try {
		res = await fetch(API + route, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(key ? { authorization: `Agent-Key ${key}` } : {}) },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000)
		});
	} catch (err) {
		return { ok: false, error: `playit.gg cannot be reached (${err instanceof Error ? err.message : String(err)}).` };
	}
	const text = await res.text();
	let parsed: { status?: string; data?: unknown };
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, error: `playit.gg answered ${res.status}: ${text.slice(0, 120)}` };
	}
	if (parsed.status === 'success') return { ok: true, data: parsed.data as T };
	const data = parsed.data as string | { message?: string; type?: string } | undefined;
	return { ok: false, error: typeof data === 'string' ? data : (data?.message ?? data?.type ?? `HTTP ${res.status}`) };
}

// ------------------------------------------------------------------ settings ---

/** `routing`: where the agent connects out ('Automatic' or a playit location, e.g. 'Germany'). */
type Linked = { agentId: string | null; linkedAt: number | null; routing?: string };
/** Per server: the tunnel MineShell made for it. */
/**
 * A public server's tunnels: the Minecraft one, and with Simple Voice Chat a
 * UDP one to its voice chat port (`voiceTunnelId`), whose address MineShell
 * wrote into the mod's voice_host (`voiceHost`, so going private only clears
 * what it wrote).
 */
export type ServerTunnel = { tunnelId: string; region: string; voiceTunnelId?: string; voiceHost?: string };

const GLOBAL_KEY = 'playit';
const SERVER_KEY = (id: string) => `playit:${id}`;

function readJson<T>(key: string): Partial<T> | null {
	const raw = db.select().from(settings).where(eq(settings.key, key)).get()?.value;
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Partial<T>;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	const json = JSON.stringify(value);
	db.insert(settings).values({ key, value: json }).onConflictDoUpdate({ target: settings.key, set: { value: json } }).run();
}

export function linkedAgent(): Linked & { routing: string } {
	const raw = readJson<Linked>(GLOBAL_KEY);
	return {
		agentId: typeof raw?.agentId === 'string' ? raw.agentId : null,
		linkedAt: typeof raw?.linkedAt === 'number' ? raw.linkedAt : null,
		routing: typeof raw?.routing === 'string' ? raw.routing : 'Automatic'
	};
}

/** The agent's page on playit.gg (rename, delete, its tunnels), and the account's agent list. */
export const DASHBOARD = 'https://playit.gg/account/agents';
export const agentPage = (agentId: string) => `${DASHBOARD}/${agentId}`;

export function serverTunnel(instanceId: string): ServerTunnel | null {
	const raw = readJson<ServerTunnel>(SERVER_KEY(instanceId));
	if (typeof raw?.tunnelId !== 'string') return null;
	return {
		tunnelId: raw.tunnelId,
		region: typeof raw.region === 'string' ? raw.region : 'global',
		...(typeof raw.voiceTunnelId === 'string' ? { voiceTunnelId: raw.voiceTunnelId } : {}),
		...(typeof raw.voiceHost === 'string' ? { voiceHost: raw.voiceHost } : {})
	};
}

function allServerTunnels(): Map<string, ServerTunnel> {
	const out = new Map<string, ServerTunnel>();
	for (const row of db.select().from(settings).where(like(settings.key, 'playit:%')).all()) {
		const id = row.key.slice('playit:'.length);
		const tunnel = serverTunnel(id);
		if (tunnel) out.set(id, tunnel);
	}
	return out;
}

async function readKey(): Promise<string | null> {
	return (await fs.readFile(KEY_FILE, 'utf8').catch(() => '')).trim() || null;
}

// --------------------------------------------------------------- the agent ---

/** The agent's user unit. Its socket lives in the runtime dir: a path under $DATA can exceed sun_path's 108 bytes. */
export function renderAgentUnit(binary = agentBinary()): string {
	return `# Managed by MineShell
[Unit]
Description=playit.gg agent for MineShell
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${binary}" --secret-path "${KEY_FILE}" --socket-path %t/${UNIT_PREFIX}-playit.sock
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Downloads the pinned release for this machine (verified) unless it is there. */
async function ensureBinary(): Promise<string> {
	const file = agentBinary();
	if (await fs.access(file).then(() => true, () => false)) return file;
	const release = AGENT_BINARIES[process.arch];
	if (!release) throw new PlayitError(`playit has no Linux agent for this machine's architecture (${process.arch}).`);
	const url = `https://github.com/playit-cloud/playit-agent/releases/download/v${AGENT_VERSION}/${release.file}`;
	const partial = `${file}.partial`;
	try {
		await downloadFile(url, partial, { hash: { algo: 'sha256', value: release.sha256 } });
	} catch (err) {
		await fs.rm(partial, { force: true });
		throw new PlayitError(`Downloading the playit agent failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	await fs.chmod(partial, 0o755);
	await fs.rename(partial, file);
	return file;
}

async function installAgent(): Promise<void> {
	await ensureBinary();
	const dir = systemdUnitDir();
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, AGENT_UNIT), renderAgentUnit(), 'utf8');
	await systemctl('daemon-reload');
	const started = await systemctl('enable', '--now', AGENT_UNIT);
	if (started.code !== 0) throw new PlayitError(`Starting the playit agent failed: ${started.stderr.trim() || `exit ${started.code}`}`);
}

async function removeAgent(): Promise<void> {
	await systemctl('disable', '--now', AGENT_UNIT);
	await fs.rm(path.join(systemdUnitDir(), AGENT_UNIT), { force: true });
	await systemctl('daemon-reload');
}

export async function agentRunning(): Promise<boolean> {
	return (await systemctl('is-active', AGENT_UNIT)).stdout.trim() === 'active';
}

/**
 * What only the agent's own log says: playit refusing it. A free account
 * takes two agents (premium ten); one more (old ones left on the account) is
 * turned away with AgentDisabledOverLimit until one is removed. Read from the
 * last lines, so a refusal followed by a connection counts as fixed.
 */
export async function agentProblem(): Promise<string | null> {
	const log = (await run(['journalctl', '--user', `--user-unit=${AGENT_UNIT}`, '-n', '40', '-o', 'cat', '--no-pager'])).stdout;
	const refused = log.lastIndexOf('AgentDisabledOverLimit');
	if (refused < 0 || refused < log.lastIndexOf('playit connected')) return null;
	return 'playit.gg turned the agent away: the account has more agents than its plan allows (one on the free plan). Remove the other agents on playit.gg (link below); this one then connects by itself.';
}

// ---------------------------------------------------------------- linking ---

export type ClaimState = {
	code: string;
	url: string;
	/** waiting: link not opened yet; visited: opened, not approved yet. */
	state: 'waiting' | 'visited' | 'finishing' | 'linked' | 'rejected' | 'expired' | 'failed';
	message: string | null;
	startedAt: number;
};

let claim: ClaimState | null = null;
const CLAIM_TIMEOUT_MS = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Tests shorten the waits. */
export const timing = { pollMs: 2000 };

export function claimState(): ClaimState | null {
	return claim;
}

/**
 * Starts linking: a claim code whose page the user opens on playit.gg and
 * approves. The rest runs in the background: wait for the approval, take
 * the agent's key, install and start the agent.
 */
export function startLink(): ClaimState {
	if (linkedAgent().agentId) throw new PlayitError('playit.gg is linked already; unlink it first.');
	if (claim && ['waiting', 'visited', 'finishing'].includes(claim.state)) return claim;
	const code = crypto.randomBytes(5).toString('hex');
	const current: ClaimState = { code, url: `https://playit.gg/claim/${code}`, state: 'waiting', message: null, startedAt: Date.now() };
	claim = current;
	void finishLink(current).catch((err) => {
		current.state = 'failed';
		current.message = err instanceof Error ? err.message : String(err);
	});
	return current;
}

export function cancelLink(): void {
	if (claim && claim.state !== 'finishing') claim = null;
}

async function finishLink(current: ClaimState): Promise<void> {
	const version = `playit ${AGENT_VERSION}`;
	for (;;) {
		if (claim !== current) return;
		if (Date.now() - current.startedAt > CLAIM_TIMEOUT_MS) {
			current.state = 'expired';
			return;
		}
		const setup = await playitApi<string>('/claim/setup', { code: current.code, agent_type: 'self-managed', version });
		if (setup.ok) {
			if (setup.data === 'UserAccepted') break;
			if (setup.data === 'UserRejected') {
				current.state = 'rejected';
				return;
			}
			current.state = setup.data === 'WaitingForUser' ? 'visited' : 'waiting';
		}
		await sleep(timing.pollMs);
	}
	current.state = 'finishing';
	let key: string | null = null;
	for (let i = 0; i < 30 && !key; i++) {
		const exchange = await playitApi<{ secret_key: string }>('/claim/exchange', { code: current.code });
		if (exchange.ok) key = exchange.data.secret_key;
		else await sleep(timing.pollMs);
	}
	if (!key) throw new PlayitError('playit.gg approved the link but did not hand over the agent key; try again.');
	await fs.mkdir(PLAYIT_DIR, { recursive: true });
	await fs.writeFile(KEY_FILE, key, { mode: 0o600 });
	const run = await playitApi<RunData>('/v1/agents/rundata', {}, key);
	if (!run.ok) throw new PlayitError(`The new agent's key does not work: ${run.error}`);
	await installAgent();
	writeJson(GLOBAL_KEY, { agentId: run.data.agent_id, linkedAt: Date.now() } satisfies Linked);
	statusCache = null;
	current.state = 'linked';
}

/**
 * Unlinks: MineShell's tunnels deleted, the agent stopped and removed, the
 * key forgotten. The agent stays listed on the playit account (the API has
 * no way to delete it); the page says so.
 */
export async function unlink(): Promise<void> {
	const key = await readKey();
	for (const [instanceId, tunnel] of allServerTunnels()) {
		if (key) await playitApi('/tunnels/delete', { tunnel_id: tunnel.tunnelId }, key);
		db.delete(settings).where(eq(settings.key, SERVER_KEY(instanceId))).run();
	}
	await removeAgent();
	await fs.rm(KEY_FILE, { force: true });
	db.delete(settings).where(eq(settings.key, GLOBAL_KEY)).run();
	claim = null;
	statusCache = null;
}

// ---------------------------------------------------------------- routing ---

export type PlayitLocation = { pop: string; name: string; online: boolean };
let locationsCache: { at: number; value: PlayitLocation[] } | null = null;

/** playit's locations an agent can connect through (kept an hour; empty when playit cannot be asked). */
export async function playitLocations(): Promise<PlayitLocation[]> {
	if (locationsCache && Date.now() - locationsCache.at < 3_600_000) return locationsCache.value;
	const answer = await playitApi<{ pops: { pop: string; name: string; online: boolean }[] }>('/info/pops', {});
	if (!answer.ok) return locationsCache?.value ?? [];
	const value = answer.data.pops.map((p) => ({ pop: p.pop, name: p.name, online: p.online })).sort((a, b) => a.name.localeCompare(b.name));
	locationsCache = { at: Date.now(), value };
	return value;
}

/**
 * Where the agent connects out: automatic (playit picks the nearest) or one
 * location. Not the tunnels' region (where players connect, Premium): this
 * one is free. The running agent moves by itself within seconds.
 */
export async function setRouting(target: string): Promise<void> {
	const key = await requireKey();
	const linked = linkedAgent();
	if (target !== 'Automatic' && !(await playitLocations()).some((l) => l.pop === target)) throw new PlayitError('Unknown playit location.');
	const routing = target === 'Automatic' ? { type: 'Automatic' } : { type: 'Pop', details: target };
	const done = await playitApi('/agents/routing/set', { agent_id: linked.agentId, routing, disable_ip6: false }, key);
	if (!done.ok) throw new PlayitError(explain(done.error === 'RequiresPremium' ? 'RequiresPlayitPremium' : done.error));
	writeJson(GLOBAL_KEY, { agentId: linked.agentId, linkedAt: linked.linkedAt, routing: target } satisfies Linked);
}

// ----------------------------------------------------------------- status ---

export type AgentTunnel = {
	id: string;
	name: string;
	display_address: string;
	tunnel_type: string | null;
	agent_config: { fields: { name: string; value: string }[] };
	disabled_reason: string | null;
};
type RunData = {
	agent_id: string;
	tunnels: AgentTunnel[];
	pending: { id: string; name: string }[];
	permissions: { is_self_managed: boolean; has_premium: boolean; account_status: string };
};

export type PlayitStatus = {
	linked: boolean;
	agentId: string | null;
	running: boolean;
	/** The API's answer, or why there is none. */
	error: string | null;
	premium: boolean;
	accountStatus: string | null;
	tunnels: AgentTunnel[];
	/** Tunnels still being set up by playit, by id. */
	pending: string[];
	/** playit refusing the agent (from its log). */
	problem: string | null;
};

let statusCache: { at: number; value: PlayitStatus } | null = null;

/** The agent and its tunnels as playit sees them; kept 15 s. */
export async function playitStatus(opts: { fresh?: boolean } = {}): Promise<PlayitStatus> {
	if (!opts.fresh && statusCache && Date.now() - statusCache.at < 15_000) return statusCache.value;
	const { agentId } = linkedAgent();
	const key = agentId ? await readKey() : null;
	const base: PlayitStatus = { linked: !!agentId, agentId, running: false, error: null, premium: false, accountStatus: null, tunnels: [], pending: [], problem: null };
	if (!agentId) return base;
	const [running, problem, answer] = await Promise.all([agentRunning(), agentProblem(), key ? playitApi<RunData>('/v1/agents/rundata', {}, key) : null]);
	const value: PlayitStatus = answer?.ok
		? {
				...base,
				running,
				problem,
				premium: answer.data.permissions.has_premium,
				accountStatus: answer.data.permissions.account_status,
				tunnels: answer.data.tunnels,
				pending: answer.data.pending.map((p) => p.id)
			}
		: { ...base, running, problem, error: answer ? answer.error : 'The agent key is missing; unlink and link again.' };
	statusCache = { at: Date.now(), value };
	return value;
}

const field = (t: AgentTunnel, name: string) => t.agent_config.fields.find((f) => f.name === name)?.value ?? null;

/** What players type for a server, when it is public and playit has given it an address; and its voice chat's. */
export function publicAddress(
	instanceId: string,
	status: PlayitStatus
): { address: string | null; pending: boolean; voice: string | null } | null {
	const mine = serverTunnel(instanceId);
	if (!mine || !status.linked) return null;
	const tunnel = status.tunnels.find((t) => t.id === mine.tunnelId);
	const voice = mine.voiceTunnelId ? status.tunnels.find((t) => t.id === mine.voiceTunnelId) : undefined;
	return { address: tunnel?.display_address || null, pending: !tunnel?.display_address, voice: voice?.display_address || null };
}

/** Tunnels on this agent that MineShell did not make (made on playit's dashboard). */
export function otherTunnels(status: PlayitStatus): (AgentTunnel & { localPort: number | null })[] {
	const ours = new Set([...allServerTunnels().values()].flatMap((t) => [t.tunnelId, t.voiceTunnelId ?? '']));
	return status.tunnels.filter((t) => !ours.has(t.id)).map((t) => ({ ...t, localPort: Number(field(t, 'local_port')) || null }));
}

// ---------------------------------------------------------------- tunnels ---

/** Where the agent reaches the server: server-ip if one is set, else this machine. */
async function localAddress(instance: ServerInstance): Promise<{ ip: string; port: number }> {
	const props = await readProperties(instance.path).catch(() => null);
	const ip = (props?.values['server-ip'] ?? '').trim();
	return { ip: /^[\d.]+$|:/.test(ip) ? ip : '127.0.0.1', port: instance.serverPort };
}

async function requireKey(): Promise<string> {
	const key = linkedAgent().agentId ? await readKey() : null;
	if (!key) throw new PlayitError('Link playit.gg first (MineShell settings, Integrations).');
	return key;
}

const ERRORS: Record<string, string> = {
	RequiresPlayitPremium: 'That needs playit Premium.',
	RequiresVerifiedAccount: 'playit.gg wants the account verified first (see playit.gg).',
	InvalidTunnelName: 'playit.gg did not accept the tunnel name.',
	AgentNotFound: 'playit.gg does not know this agent any more; unlink and link again.',
	AgentVersionTooOld: 'The playit agent has not connected yet; check that it is running and try again.'
};
const explain = (error: string) => ERRORS[error] ?? `playit.gg said: ${error}`;

/** playit's tunnel names: letters, digits, spaces, dashes. */
const tunnelName = (instance: ServerInstance) =>
	`MineShell ${instance.name}`.replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * Makes a server public: a Minecraft Java tunnel from playit to its port.
 * Right after linking playit refuses until the agent has connected once
 * (AgentVersionTooOld), so that answer is retried for a while.
 */
export async function makePublic(instance: ServerInstance, region = 'global'): Promise<ServerTunnel> {
	const key = await requireKey();
	const existing = serverTunnel(instance.id);
	if (existing) return existing;
	const local = await localAddress(instance);
	const id = await createTunnel(key, instance, { type: 'minecraft-java', portType: 'tcp', ip: local.ip, port: local.port, region });
	const tunnel: ServerTunnel = { tunnelId: id, region };
	writeJson(SERVER_KEY(instance.id), tunnel);
	statusCache = null;
	return tunnel;
}

/**
 * A tunnel from playit to a local port. Right after linking playit refuses
 * until the agent has connected once (AgentVersionTooOld), so that answer is
 * retried for a while; a name playit does not take falls back to the id.
 */
async function createTunnel(
	key: string,
	instance: ServerInstance,
	t: { type: string | null; portType: 'tcp' | 'udp'; ip: string; port: number; region: string; suffix?: string }
): Promise<string> {
	const body = (name: string) => ({
		name,
		tunnel_type: t.type,
		port_type: t.portType,
		port_count: 1,
		origin: { type: 'agent', data: { agent_id: linkedAgent().agentId, local_ip: t.ip, local_port: t.port } },
		enabled: true,
		alloc: t.region === 'global' ? null : { type: 'region', details: { region: t.region } },
		firewall_id: null,
		proxy_protocol: null
	});
	const name = (base: string) => (t.suffix ? `${base.slice(0, 39 - t.suffix.length)} ${t.suffix}` : base);
	let made = await playitApi<{ id: string }>('/tunnels/create', body(name(tunnelName(instance))), key);
	for (let i = 0; i < 15 && !made.ok && made.error === 'AgentVersionTooOld'; i++) {
		await sleep(timing.pollMs);
		made = await playitApi<{ id: string }>('/tunnels/create', body(name(tunnelName(instance))), key);
	}
	if (!made.ok && made.error === 'InvalidTunnelName') made = await playitApi<{ id: string }>('/tunnels/create', body(name(`mineshell-${instance.id}`.slice(0, 40))), key);
	if (!made.ok) throw new PlayitError(explain(made.error));
	return made.data.id;
}

/**
 * Simple Voice Chat on a public server: its own UDP tunnel to the voice chat
 * port (clients reach voice chat directly, not through the game's tunnel), and
 * that tunnel's address written into the mod's voice_host, which is where the
 * mod sends players' clients. playit gives a new tunnel its address after a
 * moment: voice_host is written once it has one, at the latest on the next
 * start. Without the mod (removed since), its tunnel goes.
 */
export async function syncVoiceTunnel(instance: ServerInstance): Promise<void> {
	const tunnel = serverTunnel(instance.id);
	if (!tunnel) return;
	const key = await readKey();
	if (!key) return;
	const voice = await voiceChat(instance);
	if (!voice) {
		if (tunnel.voiceTunnelId) {
			const done = await playitApi('/tunnels/delete', { tunnel_id: tunnel.voiceTunnelId }, key);
			if (!done.ok && done.error !== 'TunnelNotFound') throw new PlayitError(explain(done.error));
			writeJson(SERVER_KEY(instance.id), { ...tunnel, voiceTunnelId: undefined, voiceHost: undefined });
			statusCache = null;
		}
		return;
	}
	const local = await localAddress(instance);
	let voiceTunnelId = tunnel.voiceTunnelId;
	const status = await playitStatus({ fresh: true });
	let current = voiceTunnelId ? status.tunnels.find((t) => t.id === voiceTunnelId) : undefined;
	if (voiceTunnelId && !current && !status.error) {
		// Not in the run data: just made, or deleted on playit's side (then made again).
		const listed = await playitApi<{ tunnels: { id: string }[] }>('/tunnels/list', { tunnel_id: voiceTunnelId, agent_id: null }, key);
		if (listed.ok && !listed.data.tunnels.some((t) => t.id === voiceTunnelId)) voiceTunnelId = undefined;
	}
	if (!voiceTunnelId) {
		voiceTunnelId = await createTunnel(key, instance, { type: null, portType: 'udp', ip: local.ip, port: voice.port, region: tunnel.region, suffix: 'voice' });
		writeJson(SERVER_KEY(instance.id), { ...tunnel, voiceTunnelId });
		statusCache = null;
		current = (await playitStatus({ fresh: true })).tunnels.find((t) => t.id === voiceTunnelId);
	} else if (current && field(current, 'local_port') !== String(voice.port)) {
		const done = await playitApi('/tunnels/update', { tunnel_id: voiceTunnelId, local_ip: local.ip, local_port: voice.port, agent_id: linkedAgent().agentId, enabled: true }, key);
		if (!done.ok) throw new PlayitError(explain(done.error));
		statusCache = null;
	}
	const address = current?.display_address;
	if (address && voice.host !== address) {
		await setVoiceConfig(instance, { host: address });
		writeJson(SERVER_KEY(instance.id), { ...(serverTunnel(instance.id) ?? tunnel), voiceTunnelId, voiceHost: address });
	}
}

/** Back to local only: the tunnel deleted. One playit no longer has counts as gone. */
export async function makePrivate(instanceId: string): Promise<void> {
	const tunnel = serverTunnel(instanceId);
	if (!tunnel) return;
	const key = await readKey();
	if (key) {
		for (const id of [tunnel.tunnelId, tunnel.voiceTunnelId]) {
			if (!id) continue;
			const done = await playitApi('/tunnels/delete', { tunnel_id: id }, key);
			if (!done.ok && done.error !== 'TunnelNotFound') throw new PlayitError(explain(done.error));
		}
	}
	// voice_host back to the server's own address, if it is still the one MineShell wrote.
	const instance = db.select().from(serverInstances).where(eq(serverInstances.id, instanceId)).get();
	if (instance && tunnel.voiceHost && (await voiceChat(instance))?.host === tunnel.voiceHost) await setVoiceConfig(instance, { host: '' });
	db.delete(settings).where(eq(settings.key, SERVER_KEY(instanceId))).run();
	statusCache = null;
}

/**
 * Before a start: points the server's tunnel at its current port (a changed
 * port only applies on restart, so this is when the tunnel follows). The
 * tunnel keeps its id and address.
 */
export async function syncTunnel(instance: ServerInstance): Promise<void> {
	const tunnel = serverTunnel(instance.id);
	if (!tunnel) return;
	const key = await readKey();
	if (!key) return;
	const status = await playitStatus({ fresh: true });
	const current = status.tunnels.find((t) => t.id === tunnel.tunnelId);
	const local = await localAddress(instance);
	if (current && field(current, 'local_port') === String(local.port) && field(current, 'local_ip') === local.ip) return;
	if (!current && !status.error) {
		// Not in the agent's run data: just made (it takes playit a moment to list it there), or
		// deleted on playit's side. The account's tunnel list knows; a deleted one is forgotten,
		// so the switch shows the truth.
		const listed = await playitApi<{ tunnels: { id: string; origin?: { data?: { local_ip?: string; local_port?: number } } }[] }>(
			'/tunnels/list',
			{ tunnel_id: tunnel.tunnelId, agent_id: null },
			key
		);
		const account = listed.ok ? listed.data.tunnels.find((t) => t.id === tunnel.tunnelId) : undefined;
		if (listed.ok && !account) {
			db.delete(settings).where(eq(settings.key, SERVER_KEY(instance.id))).run();
			return;
		}
		if (account?.origin?.data?.local_port === local.port && account.origin.data.local_ip === local.ip) return;
	}
	const done = await playitApi('/tunnels/update', { tunnel_id: tunnel.tunnelId, local_ip: local.ip, local_port: local.port, agent_id: linkedAgent().agentId, enabled: true }, key);
	if (!done.ok) throw new PlayitError(explain(done.error));
	statusCache = null;
}

/** Before a start: the server's tunnels follow its ports, voice chat's included. */
export async function syncTunnels(instance: ServerInstance): Promise<void> {
	await syncTunnel(instance);
	await syncVoiceTunnel(instance);
}

/** With the server: its tunnel deleted (best effort; the server goes either way). */
export async function deletePlayitData(instanceId: string): Promise<void> {
	await makePrivate(instanceId).catch(() => db.delete(settings).where(eq(settings.key, SERVER_KEY(instanceId))).run());
}
