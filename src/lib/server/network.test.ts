import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { primaryLanAddress } from './network';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo;

describe('primaryLanAddress', () => {
	it("takes the network card's address over a VPN's or a container bridge's listed before it", () => {
		expect(
			primaryLanAddress({
				lo: [v4('127.0.0.1', true)],
				tailscale0: [v4('100.91.198.110')],
				docker0: [v4('172.17.0.1')],
				enp2s0: [v4('192.168.0.200')]
			})
		).toBe('192.168.0.200');
		expect(primaryLanAddress({ 'br-3f2a': [v4('172.18.0.1')], wlan0: [v4('10.0.0.23')] })).toBe('10.0.0.23');
	});

	it('falls back to the first address there is, then the hostname', () => {
		expect(primaryLanAddress({ lo: [v4('127.0.0.1', true)], eth0: [v4('203.0.113.7')], tailscale0: [v4('100.64.0.2')] })).toBe('203.0.113.7');
		expect(primaryLanAddress({ tailscale0: [v4('100.64.0.2')] })).toBe('100.64.0.2');
		expect(primaryLanAddress({ lo: [v4('127.0.0.1', true)] })).toBeTruthy();
	});
});
