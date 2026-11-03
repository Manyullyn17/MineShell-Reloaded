import fs from 'node:fs/promises';
import os from 'node:os';
import { parseNetTable } from './portmap';
import { run } from './systemd';

/**
 * HTTPS through Tailscale: `tailscale serve` gives MineShell an address on the tailnet,
 * https://<machine>.<tailnet>.ts.net, with a real certificate, reachable only from the
 * tailnet's own devices (DEPLOYMENT, "Remote access"). Its port 443 forwards to MineShell's
 * plain-http port on this machine.
 *
 * MineShell only reads Tailscale's state and turns that one forward on or off. It never
 * replaces a 443 that serves something else, and never touches Funnel (which would put
 * MineShell on the public internet). Changing serve settings needs root, or this account
 * made Tailscale's operator once (`sudo tailscale set --operator=<account>`), which it reads
 * from `tailscale debug prefs` (a debug command: when that fails, it is not known, and
 * Tailscale's own refusal says so instead).
 */

export type ServeState =
	/** 443 forwards to this MineShell. */
	| { kind: 'ours'; url: string; funnel: boolean }
	| { kind: 'free' }
	/** 443 forwards somewhere else (another program, or MineShell on another port). */
	| { kind: 'other'; target: string };

export type TailscaleState =
	| { kind: 'missing' }
	/** Installed, but not signed in or not running. */
	| { kind: 'down'; message: string }
	| {
			kind: 'up';
			/** The machine's name on the tailnet, machine.tailnet.ts.net. */
			name: string;
			/** Whether the tailnet hands out certificates (admin console, DNS, "HTTPS Certificates"). */
			https: boolean;
			serve: ServeState;
			/** MineShell's own port, which 443 forwards to. */
			port: number;
			/** Whether this account may change what Tailscale serves (root, or its operator); null when not known. */
			operator: boolean | null;
			/** The account to make operator, as `sudo tailscale set --operator=` takes it. */
			account: string;
			/** This machine's page in the admin console (by its tailnet address), and the list of machines. */
			admin: { machine: string | null; machines: string };
	  };

export const ADMIN_DNS = 'https://login.tailscale.com/admin/dns';
const ADMIN_MACHINES = 'https://login.tailscale.com/admin/machines';

/** The account MineShell runs as. */
const account = () => os.userInfo().username;

/** What makes this account Tailscale's operator: run once, as anyone who may sudo. */
export const operatorCommand = () => `sudo tailscale set --operator=${account()}`;

/** Whether this account may change Tailscale's settings, from its prefs; null when they cannot be read. */
async function isOperator(): Promise<boolean | null> {
	if (process.getuid?.() === 0) return true;
	const res = await run(['tailscale', 'debug', 'prefs'], { timeoutMs: 10_000 });
	try {
		const prefs = JSON.parse(res.stdout) as { OperatorUser?: string | null };
		return (prefs.OperatorUser ?? '') === account();
	} catch {
		return null;
	}
}

/**
 * The plain-http port this MineShell listens on: PORT when set (the installed service),
 * else the TCP port this process listens on (a dev server's). Null when neither is known.
 */
export async function ownPort(): Promise<number | null> {
	const set = Number(process.env.PORT);
	if (Number.isInteger(set) && set > 0) return set;
	const inodes = new Set<number>();
	for (const fd of await fs.readdir('/proc/self/fd').catch(() => [] as string[])) {
		const inode = Number((await fs.readlink(`/proc/self/fd/${fd}`).catch(() => '')).match(/^socket:\[(\d+)\]$/)?.[1]);
		if (inode) inodes.add(inode);
	}
	const ports: number[] = [];
	for (const file of ['tcp', 'tcp6']) {
		const text = await fs.readFile(`/proc/net/${file}`, 'utf8').catch(() => '');
		for (const s of parseNetTable(text, 'tcp')) if (inodes.has(s.inode)) ports.push(s.port);
	}
	return ports.length ? Math.min(...ports) : null;
}

/** What `tailscale serve status --json` says port 443 of `name` does. */
export function serveState(json: unknown, name: string, port: number): ServeState {
	const config = (json ?? {}) as {
		Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
		TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
		AllowFunnel?: Record<string, boolean>;
	};
	const host = `${name}:443`;
	const web = config.Web?.[host];
	const tcp = config.TCP?.['443'];
	if (!web && !tcp) return { kind: 'free' };
	if (tcp?.TCPForward) return { kind: 'other', target: `tcp://${tcp.TCPForward}` };
	const handlers = Object.entries(web?.Handlers ?? {});
	const root = handlers.find(([p]) => p === '/')?.[1];
	const proxy = root?.Proxy ?? '';
	const ours = handlers.length === 1 && /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])?:?(\d+)\/?$/.exec(proxy);
	if (ours && Number(ours[3]) === port) return { kind: 'ours', url: `https://${name}`, funnel: config.AllowFunnel?.[host] === true };
	const target = handlers.map(([p, h]) => `${p} -> ${h.Proxy ?? h.Path ?? (h.Text !== undefined ? 'text' : '?')}`).join(', ');
	return { kind: 'other', target: target || 'something' };
}

export async function tailscaleState(): Promise<TailscaleState> {
	const status = await run(['tailscale', 'status', '--json'], { timeoutMs: 10_000 });
	if (status.code === 127) return { kind: 'missing' };
	let parsed: { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] }; CertDomains?: string[] | null };
	try {
		parsed = JSON.parse(status.stdout);
	} catch {
		return { kind: 'down', message: (status.stderr || status.stdout).trim() || `tailscale status failed (exit ${status.code}).` };
	}
	const name = (parsed.Self?.DNSName ?? '').replace(/\.$/, '');
	if (parsed.BackendState !== 'Running' || !name) {
		return { kind: 'down', message: parsed.BackendState === 'NeedsLogin' ? 'Tailscale is installed but not signed in: run `sudo tailscale up` on this machine.' : `Tailscale is not running (${parsed.BackendState ?? 'unknown state'}).` };
	}
	const port = (await ownPort()) ?? 3000;
	const serve = await run(['tailscale', 'serve', 'status', '--json'], { timeoutMs: 10_000 });
	let config: unknown = {};
	try {
		config = serve.stdout.trim() ? JSON.parse(serve.stdout) : {};
	} catch {
		// Older versions print text when nothing is served.
	}
	const ipv4 = parsed.Self?.TailscaleIPs?.find((ip) => !ip.includes(':'));
	return {
		kind: 'up',
		name,
		https: (parsed.CertDomains ?? []).includes(name),
		serve: serveState(config, name, port),
		port,
		operator: await isOperator(),
		account: account(),
		admin: { machine: ipv4 ? `${ADMIN_MACHINES}/${ipv4}` : null, machines: ADMIN_MACHINES }
	};
}

let tailnetCache: { at: number; address: Promise<string | null> } | null = null;

/**
 * Where this machine's tailnet devices reach it: its MagicDNS name when the tailnet has
 * MagicDNS on, else its 100.x address; null without Tailscale running. For the overview's
 * Connect box, which reloads every few seconds: `tailscale status` is asked once a minute.
 */
export function tailnetAddress(now = Date.now()): Promise<string | null> {
	if (tailnetCache && now - tailnetCache.at < 60_000) return tailnetCache.address;
	const address = run(['tailscale', 'status', '--json'], { timeoutMs: 10_000 }).then((status) => {
		try {
			const parsed = JSON.parse(status.stdout) as {
				BackendState?: string;
				Self?: { DNSName?: string; TailscaleIPs?: string[] };
				CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
			};
			if (parsed.BackendState !== 'Running') return null;
			const name = (parsed.Self?.DNSName ?? '').replace(/\.$/, '');
			const ipv4 = parsed.Self?.TailscaleIPs?.find((ip) => !ip.includes(':')) ?? null;
			return parsed.CurrentTailnet?.MagicDNSEnabled && name ? name : ipv4;
		} catch {
			return null;
		}
	});
	tailnetCache = { at: now, address: address.catch(() => null) };
	return tailnetCache.address;
}

const NOT_OPERATOR = () => `Tailscale only lets root or its operator change what it serves. Run this once on the machine, then try again: ${operatorCommand()}`;

/** Tailscale's answer to a refused change, as something to do about it. */
function refusal(res: { code: number; stdout: string; stderr: string }): string {
	const said = (res.stderr || res.stdout).trim();
	if (/access denied|permission denied|operator/i.test(said)) {
		return NOT_OPERATOR();
	}
	if (/https.*(not enabled|disabled)|certificates?.*(not enabled|disabled)|enable https/i.test(said)) {
		return `HTTPS certificates are off for this tailnet: turn them on in the admin console (${ADMIN_DNS}, "HTTPS Certificates"), then try again.`;
	}
	return said.split('\n').slice(-3).join(' ') || `tailscale serve failed (exit ${res.code}).`;
}

/** Serves MineShell at https://<machine>.<tailnet>.ts.net, kept across reboots (--bg). */
export async function serveOverTailscale(): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
	const state = await tailscaleState();
	if (state.kind === 'missing') return { ok: false, message: 'Tailscale is not installed on this machine.' };
	if (state.kind === 'down') return { ok: false, message: state.message };
	if (state.serve.kind === 'ours') return { ok: true, url: state.serve.url };
	if (state.serve.kind === 'other') return { ok: false, message: `Tailscale's port 443 already serves ${state.serve.target}. MineShell leaves it alone: free it with \`tailscale serve --https=443 off\` first if it is no longer needed.` };
	if (state.operator === false) return { ok: false, message: NOT_OPERATOR() };
	if (!state.https) return { ok: false, message: `HTTPS certificates are off for this tailnet: turn them on in the admin console (${ADMIN_DNS}, "HTTPS Certificates"), then try again.` };
	const res = await run(['tailscale', 'serve', '--bg', '--https=443', `http://127.0.0.1:${state.port}`], { timeoutMs: 30_000 });
	if (res.code !== 0) return { ok: false, message: refusal(res) };
	return { ok: true, url: `https://${state.name}` };
}

/** Stops serving MineShell over Tailscale; refused when 443 serves something else. */
export async function stopServingOverTailscale(): Promise<{ ok: true } | { ok: false; message: string }> {
	const state = await tailscaleState();
	if (state.kind !== 'up' || state.serve.kind === 'free') return { ok: true };
	if (state.serve.kind === 'other') return { ok: false, message: `Tailscale's port 443 serves ${state.serve.target}, not this MineShell: left as it is.` };
	const res = await run(['tailscale', 'serve', '--https=443', 'off'], { timeoutMs: 30_000 });
	return res.code === 0 ? { ok: true } : { ok: false, message: refusal(res) };
}
