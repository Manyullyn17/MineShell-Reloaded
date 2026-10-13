import net from 'node:net';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';
import { currentActor } from './requestcontext';
import { noteBlockedDownload } from './tasks';
import type { BlockedDownload } from '#lib/shared/downloads.js';

/**
 * Which addresses downloads may reach (download.ts). Pack files carry their
 * own URLs, and anyone allowed to create a server can upload one, so by
 * default nothing on this machine or the local network is fetched. The owner
 * or a global admin can allow an exact address (the user's call, 2026-10-13:
 * a local mirror or a Tailscale host is a real use; a whole range is more than
 * anyone asked for, and a name could later resolve elsewhere).
 */

/** Each kind of non-public address, with how the question names it. Node checks IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 rules. */
const KINDS: { kind: string; ranges: [string, number, 'ipv4' | 'ipv6'][] }[] = [
	{ kind: 'this machine', ranges: [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']] },
	{
		kind: 'an address on your local network',
		ranges: [['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6']]
	},
	{
		kind: 'a link-local address (cloud servers answer metadata requests on one)',
		ranges: [['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']]
	},
	{ kind: 'a shared address used by VPNs such as Tailscale and by carrier NAT', ranges: [['100.64.0.0', 10, 'ipv4']] },
	{
		kind: 'a reserved or multicast address',
		// 198.18.0.0/15 (benchmarking) is left out: proxies with fake-IP DNS answer every name from it.
		ranges: [['0.0.0.0', 8, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['224.0.0.0', 3, 'ipv4'], ['::', 128, 'ipv6'], ['ff00::', 8, 'ipv6']]
	}
];

const LISTS = KINDS.map(({ kind, ranges }) => {
	const list = new net.BlockList();
	for (const [address, prefix, type] of ranges) list.addSubnet(address, prefix, type);
	return { kind, list };
});

/** What kind of non-public address this is, or null for a public one. */
export function addressKind(address: string): string | null {
	const type = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
	return LISTS.find(({ list }) => list.check(address, type))?.kind ?? null;
}

export type AllowedAddress = { address: string; host: string; addedAt: number; addedBy: string | null };

const ALLOWED_KEY = 'downloads.allowedAddresses';

/** Every read is validated, so a hand-edited row degrades to fewer entries, never to an error. */
export function allowedAddresses(): AllowedAddress[] {
	const raw = db.select().from(settings).where(eq(settings.key, ALLOWED_KEY)).get()?.value;
	try {
		const list: unknown = JSON.parse(raw ?? '[]');
		if (!Array.isArray(list)) return [];
		return list.filter(
			(a): a is AllowedAddress =>
				!!a && typeof a.address === 'string' && net.isIP(a.address) > 0 && typeof a.host === 'string' && typeof a.addedAt === 'number'
		);
	} catch {
		return [];
	}
}

function saveAllowed(list: AllowedAddress[]): void {
	const value = JSON.stringify(list);
	db.insert(settings).values({ key: ALLOWED_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

export function isAllowedAddress(address: string): boolean {
	return allowedAddresses().some((a) => a.address === address);
}

/** A task as the browser gets it: refusals since allowed are no longer asked about. */
export function withoutAllowed<T extends { blocked: BlockedDownload[] }>(task: T): T {
	if (!task.blocked.length) return task;
	const allowed = new Set(allowedAddresses().map((a) => a.address));
	return { ...task, blocked: task.blocked.filter((b) => !allowed.has(b.address)) };
}

export function allowAddress(address: string, host: string): void {
	const list = allowedAddresses().filter((a) => a.address !== address);
	list.push({ address, host, addedAt: Date.now(), addedBy: currentActor()?.username ?? null });
	saveAllowed(list);
	for (let i = refusals.length - 1; i >= 0; i--) if (refusals[i].address === address) refusals.splice(i, 1);
}

export function removeAllowedAddress(address: string): boolean {
	const list = allowedAddresses();
	const kept = list.filter((a) => a.address !== address);
	saveAllowed(kept);
	return kept.length < list.length;
}

export type Refusal = BlockedDownload & { url: string; at: number; by: string | null };

/** Recent refusals, newest first, one per host and address, for MineShell settings. In memory: a restart forgets them. */
const refusals: Refusal[] = [];
const MAX_REFUSALS = 20;

export function recentRefusals(): Refusal[] {
	return [...refusals];
}

export class BlockedDownloadError extends Error {
	constructor(
		message: string,
		/** Null when the URL itself was refused (not http or https): no address to allow. */
		readonly blocked: BlockedDownload | null = null
	) {
		super(message);
	}
}

/** The error for a refused address, recorded for MineShell settings and the task it happened in. */
export function refuse(url: string, blocked: BlockedDownload): BlockedDownloadError {
	const index = refusals.findIndex((r) => r.host === blocked.host && r.address === blocked.address);
	if (index >= 0) refusals.splice(index, 1);
	refusals.unshift({ ...blocked, url, at: Date.now(), by: currentActor()?.username ?? null });
	refusals.length = Math.min(refusals.length, MAX_REFUSALS);
	noteBlockedDownload(blocked);
	const what = blocked.host === blocked.address ? `${blocked.address} is` : `${blocked.host} is ${blocked.address},`;
	return new BlockedDownloadError(
		`Refused to download ${url}: ${what} ${blocked.kind}. The owner or a global admin can allow this address (Activity, or MineShell settings > System).`,
		blocked
	);
}
