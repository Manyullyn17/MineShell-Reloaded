import { describe, expect, it } from 'vitest';
import type os from 'node:os';
import { globalIpv6, ipv6Exposure, rconFirewallCommand, ufwDeniesIpv6, wildcardIpv6Ports } from './ipv6exposure';
import { createInstance } from '../../../tests/helpers/instances';

/** /proc/net/tcp6 as this machine had it (2026-11-03): a port on every address, on 127.0.0.1 only, on Tailscale's address. */
const header = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (address: string, port: number, state = '0A') =>
	`   0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000000000000000000000000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 2911036 1 0000000000000000 100 0 0 10 0`;
const ANY = '0'.repeat(32);
const LOOPBACK = '0000000000000000FFFF00000100007F';
const TAILNET = '5C117AFD0000E0A1000000009AC60196';

const v6 = (address: string, internal = false) => ({ address, family: 'IPv6', internal, netmask: '', mac: '', cidr: null, scopeid: 0 }) as os.NetworkInterfaceInfo;
const PUBLIC = { lo: [v6('::1', true)], wlan0: [v6('fe80::5a47:caff:fe7a:38c8'), v6('2a02:8388:e6cc:9380:5a47:caff:fe7a:38c8')], tailscale0: [v6('fd7a:115c:a1e0::9601:c69a')] };
const HOME_ONLY = { lo: [v6('::1', true)], wlan0: [v6('fe80::1')], tailscale0: [v6('fd7a:115c:a1e0::1')] };

describe('ports reachable over IPv6', () => {
	it('finds public addresses only: not loopback, link-local or Tailscale’s', () => {
		expect(globalIpv6(PUBLIC)).toEqual(['2a02:8388:e6cc:9380:5a47:caff:fe7a:38c8']);
		expect(globalIpv6(HOME_ONLY)).toEqual([]);
	});

	it('counts sockets on every address, not ones on one address, and only listening ones', () => {
		const text = [header, row(ANY, 25565), row(LOOPBACK, 8123), row(TAILNET, 443), row(ANY, 40000, '01')].join('\n');
		expect(wildcardIpv6Ports(text, 'tcp')).toEqual([25565]);
		expect(wildcardIpv6Ports([header, row(ANY, 24454, '07')].join('\n'), 'udp')).toEqual([24454]);
	});

	it('reads whether ufw turns IPv6 connections away by default', async () => {
		const files = (conf: string, defaults: string) => async (file: string) => (file.endsWith('ufw.conf') ? conf : defaults);
		expect(await ufwDeniesIpv6(files('ENABLED=yes\n', 'IPV6=yes\nDEFAULT_INPUT_POLICY="DROP"\n'))).toBe(true);
		expect(await ufwDeniesIpv6(files('ENABLED=no\n', 'IPV6=yes\nDEFAULT_INPUT_POLICY="DROP"\n'))).toBe(false);
		expect(await ufwDeniesIpv6(files('ENABLED=yes\n', 'IPV6=no\nDEFAULT_INPUT_POLICY="DROP"\n'))).toBe(false);
		expect(await ufwDeniesIpv6(files('ENABLED=yes\n', 'IPV6=yes\nDEFAULT_INPUT_POLICY="ACCEPT"\n'))).toBe(false);
		expect(await ufwDeniesIpv6(async () => { throw new Error('no ufw'); })).toBe(false);
	});

	it("names a server's RCON when it listens on a public address, and stays quiet about game ports alone", async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.11', serverPort: 47565, rconPort: 48565 });
		const proc = (ports: number[]) => async (file: string) => {
			if (file === '/proc/net/tcp6') return [header, ...ports.map((p) => row(ANY, p))].join('\n');
			if (file.startsWith('/proc/net/')) return header;
			throw new Error('no ufw');
		};
		const exposure = await ipv6Exposure(PUBLIC, proc([47565, 48565]));
		expect(exposure).toMatchObject({ address: '2a02:8388:e6cc:9380:5a47:caff:fe7a:38c8', ufwDenies: false });
		expect(exposure!.ports.filter((p) => p.name === instance.name)).toEqual([
			{ kind: 'rcon', name: instance.name, port: 48565, protocol: 'tcp' },
			{ kind: 'game', name: instance.name, port: 47565, protocol: 'tcp' }
		]);
		expect(rconFirewallCommand(exposure!.ports)).toContain('48565');
		// The game port is meant to be reachable; without a public address nothing is.
		expect(await ipv6Exposure(PUBLIC, proc([47565]))).toBeNull();
		expect(await ipv6Exposure(HOME_ONLY, proc([47565, 48565]))).toBeNull();
	});

	it('names MineShell itself when it listens on every IPv6 address (HOST=::)', async () => {
		const exposure = await ipv6Exposure(PUBLIC, async (file) => (file === '/proc/net/tcp6' ? [header, row(ANY, 3000)].join('\n') : header));
		expect(exposure!.ports).toContainEqual({ kind: 'panel', name: null, port: 3000, protocol: 'tcp' });
		expect(rconFirewallCommand(exposure!.ports)).toBeNull();
	});
});
