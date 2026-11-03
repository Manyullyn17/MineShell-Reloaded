import fs from 'node:fs/promises';
import os from 'node:os';
import { serverPorts, type Protocol } from './portmap';
import type { PortKind } from '#lib/shared/ports.js';

/**
 * Ports reachable over IPv6 with nothing forwarded. A home router forwards IPv4 only on
 * request, but over IPv6 the machine often has a public address of its own, so a port
 * listening on every address is reachable from the internet unless the router's IPv6
 * firewall turns connections from outside away (most do by default; MineShell cannot see
 * it). Minecraft's Java listens on IPv6 too (`*:port`), RCON included; MineShell's own
 * port only with HOST=:: (the installer writes 0.0.0.0, IPv4 only). Checked 2026-11-03 on
 * this machine: game, RCON and voice chat on `*`, port 3000 on 0.0.0.0.
 *
 * scripts/doctor.mjs has its own copy of this (it runs without the app's code).
 */

export type ExposedPort = { kind: PortKind | 'panel'; name: string | null; port: number; protocol: Protocol };
export type Ipv6Exposure = {
	address: string;
	ports: ExposedPort[];
	/** ufw is on for IPv6 and turns incoming connections away unless a rule lets them in. */
	ufwDenies: boolean;
};

/**
 * Whether ufw is on for IPv6 with incoming connections turned away by default, from its
 * config files (world-readable; `ufw status` and its rules need root). Then a port is closed
 * unless a rule allows it, which only `sudo ufw status` shows.
 */
type Read = (file: string) => Promise<string>;
const readFile: Read = (file) => fs.readFile(file, 'utf8');

export async function ufwDeniesIpv6(read: Read = readFile): Promise<boolean> {
	const value = (text: string, key: string) => text.match(new RegExp(`^${key}=\"?(\\w+)`, 'm'))?.[1]?.toLowerCase();
	const conf = await read('/etc/ufw/ufw.conf').catch(() => '');
	const defaults = await read('/etc/default/ufw').catch(() => '');
	return value(conf, 'ENABLED') === 'yes' && value(defaults, 'IPV6') === 'yes' && ['drop', 'reject'].includes(value(defaults, 'DEFAULT_INPUT_POLICY') ?? '');
}

/** The machine's public IPv6 addresses (2000::/3): not link-local, not ULA (Tailscale's fd7a:...). */
export function globalIpv6(interfaces = os.networkInterfaces()): string[] {
	return Object.values(interfaces)
		.flat()
		.filter((a) => !!a && a.family === 'IPv6' && !a.internal && /^[23][0-9a-f]{0,3}:/i.test(a.address))
		.map((a) => a!.address);
}

/** Ports with a socket on every IPv6 address (`::`, which takes IPv4 too) in /proc/net/tcp6 or udp6. */
export function wildcardIpv6Ports(text: string, protocol: Protocol): number[] {
	const ports: number[] = [];
	for (const line of text.split('\n').slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 10 || f[3] !== (protocol === 'tcp' ? '0A' : '07')) continue;
		const [address, port] = f[1].split(':');
		if (/^0{32}$/.test(address)) ports.push(parseInt(port, 16));
	}
	return ports;
}

/** RCON first: the console, wanted by MineShell alone and only from this machine. */
const ORDER: ExposedPort['kind'][] = ['panel', 'rcon', 'map', 'game', 'query', 'voice'];

/**
 * MineShell's ports listening on a public IPv6 address, when RCON or MineShell itself is among
 * them; null otherwise (game and voice chat ports are meant to be reachable).
 */
export async function ipv6Exposure(interfaces = os.networkInterfaces(), read: Read = readFile): Promise<Ipv6Exposure | null> {
	const [address] = globalIpv6(interfaces);
	if (!address) return null;
	const open = new Set<string>();
	for (const protocol of ['tcp', 'udp'] as const) {
		const text = await read(`/proc/net/${protocol}6`).catch(() => '');
		for (const port of wildcardIpv6Ports(text, protocol)) open.add(`${protocol}:${port}`);
	}
	const ports: ExposedPort[] = (await serverPorts())
		.filter((e) => open.has(`${e.protocol}:${e.port}`))
		.map((e) => ({ kind: e.kind, name: e.name, port: e.port, protocol: e.protocol }));
	const panel = Number(process.env.PORT) || 3000;
	if (open.has(`tcp:${panel}`)) ports.push({ kind: 'panel', name: null, port: panel, protocol: 'tcp' });
	if (!ports.some((p) => p.kind === 'rcon' || p.kind === 'panel')) return null;
	ports.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.port - b.port);
	return { address, ports, ufwDenies: await ufwDeniesIpv6(read) };
}

/** A ufw rule keeping these RCON ports to this machine (ufw always lets loopback through, and MineShell uses 127.0.0.1). */
export function rconFirewallCommand(ports: ExposedPort[]): string | null {
	const rcon = [...new Set(ports.filter((p) => p.kind === 'rcon').map((p) => p.port))];
	return rcon.length ? `sudo ufw deny proto tcp to any port ${rcon.join(',')}` : null;
}
