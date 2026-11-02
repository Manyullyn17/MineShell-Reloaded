import { hostname, networkInterfaces } from 'node:os';

type Interfaces = ReturnType<typeof networkInterfaces>;

/** Interfaces that are not the home network: VPNs and tunnels, containers and VMs. */
const NOT_LAN = /^(tailscale|zt|wg|tun|tap|docker|br-|veth|virbr|vmnet|vboxnet|lxcbr|lxdbr|cni|flannel|podman)/;
/** The private ranges a home router hands out. */
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * The address players on the same network type: the first private IPv4 of an
 * interface that is not a VPN, container or VM bridge (Tailscale's 100.x or
 * docker0's 172.17.0.1 can come before the network card), else the first
 * non-internal IPv4 as before. Falls back to the hostname if the machine
 * somehow has none (e.g. no network up at all) - still wrong on a typical
 * LAN, but no worse than before.
 */
export function primaryLanAddress(interfaces: Interfaces = networkInterfaces()): string {
	const all = Object.entries(interfaces).flatMap(([name, addrs]) =>
		(addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address }))
	);
	const lan = all.find((a) => !NOT_LAN.test(a.name) && PRIVATE.test(a.address));
	return (lan ?? all[0])?.address ?? hostname();
}
