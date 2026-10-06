import { hostname, networkInterfaces } from 'node:os';

/**
 * First non-internal IPv4 address found across interfaces. Falls back to the
 * hostname if the machine somehow has none (e.g. no network up at all) -
 * still wrong on a typical LAN, but no worse than before.
 */
export function primaryLanAddress(): string {
	for (const addrs of Object.values(networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family === 'IPv4' && !addr.internal) return addr.address;
		}
	}
	return hostname();
}
