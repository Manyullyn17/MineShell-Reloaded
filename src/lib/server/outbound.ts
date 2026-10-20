/**
 * Every request MineShell makes to the outside goes through outboundFetch, which
 * remembers per service when it last answered and when it last failed. When
 * modpacks.ch or Modrinth is down, an install fails with whatever that service
 * sent; the Activity page's list shows it as the outage it is.
 *
 * A failure is no answer at all (DNS, refused, reset, timeout) or a 5xx/429:
 * the service is down or turning MineShell away. Any other status is an answer
 * (a 404 for a removed file says the service works). Only service names, times
 * and a short reason are kept, never URLs (they can carry tokens), and only in
 * memory: it says how things went since MineShell started.
 */

export type ServiceState = {
	name: string;
	lastOkAt: number | null;
	lastFailedAt: number | null;
	/** "HTTP 502", "timed out", "not found (DNS)", ... */
	lastFailure: string | null;
	/** Failures since the last answer: 0 when it answered last. */
	failingFor: number;
	/** When the failures since the last answer began. */
	failingSince: number | null;
};

/** Host suffix -> the service it belongs to; anything else is listed by its host name. */
const SERVICES: [string, string][] = [
	['modrinth.com', 'Modrinth'],
	['modpacks.ch', 'modpacks.ch (FTB, CurseForge mirror)'],
	['curseforge.com', 'CurseForge'],
	['forgecdn.net', 'CurseForge downloads'],
	['mojang.com', 'Mojang'],
	['minecraft.net', 'Mojang'],
	['adoptium.net', 'Adoptium (Java)'],
	['azul.com', 'Azul (Java)'],
	['fabricmc.net', 'Fabric'],
	['quiltmc.org', 'Quilt'],
	['minecraftforge.net', 'Forge'],
	['neoforged.net', 'NeoForge'],
	['cleanroommc.com', 'Cleanroom'],
	['github.com', 'GitHub'],
	['githubusercontent.com', 'GitHub'],
	['playit.gg', 'playit.gg'],
	['mclo.gs', 'mclo.gs'],
	['lucko.me', 'Spark viewer'],
	['discord.com', 'Discord'],
	['ntfy.sh', 'ntfy']
];

export function serviceName(url: string): string {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return 'unknown';
	}
	for (const [suffix, name] of SERVICES) {
		if (host === suffix || host.endsWith(`.${suffix}`)) return name;
	}
	return host;
}

// On globalThis so a dev reload of this module keeps what was seen.
const shared = globalThis as { __mineshellServices?: Map<string, ServiceState> };
const services = (shared.__mineshellServices ??= new Map());

function note(url: string, failure: string | null): void {
	const name = serviceName(url);
	const state = services.get(name) ?? { name, lastOkAt: null, lastFailedAt: null, lastFailure: null, failingFor: 0, failingSince: null };
	if (failure === null) {
		state.lastOkAt = Date.now();
		state.failingFor = 0;
		state.failingSince = null;
	} else {
		if (state.failingFor === 0) state.failingSince = Date.now();
		state.lastFailedAt = Date.now();
		state.lastFailure = failure;
		state.failingFor++;
	}
	services.set(name, state);
}

function reason(err: unknown): string {
	if (!(err instanceof Error)) return 'no answer';
	if (err.name === 'TimeoutError') return 'timed out';
	const code = (err.cause as { code?: string } | undefined)?.code ?? (err as { code?: string }).code;
	switch (code) {
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
			return 'not found (DNS)';
		case 'ECONNREFUSED':
			return 'refused the connection';
		case 'ECONNRESET':
			return 'dropped the connection';
		case 'ETIMEDOUT':
		case 'UND_ERR_CONNECT_TIMEOUT':
		case 'UND_ERR_HEADERS_TIMEOUT':
			return 'timed out';
		default:
			return code ? `no answer (${code})` : 'no answer';
	}
}

/** fetch, with the outcome noted for the service it went to. */
export async function outboundFetch(input: string | URL, init?: RequestInit): Promise<Response> {
	const url = String(input);
	try {
		const res = await fetch(input, init);
		note(url, res.status >= 500 || res.status === 429 ? `HTTP ${res.status}` : null);
		return res;
	} catch (err) {
		// Cancelled by MineShell (a task stopped): says nothing about the service.
		if (!init?.signal?.aborted) note(url, reason(err));
		throw err;
	}
}

/** The services contacted since MineShell started, failing ones first. */
export function serviceStates(): ServiceState[] {
	return [...services.values()].sort((a, b) => Number(b.failingFor > 0) - Number(a.failingFor > 0) || a.name.localeCompare(b.name));
}

/** For tests: forget everything seen. */
export function resetServiceStates(): void {
	services.clear();
}
