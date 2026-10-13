/**
 * A download refused because its host is, or resolves to, a non-public
 * address (download.ts). The owner or a global admin can allow that exact
 * address; the browser shows this to ask.
 */
export type BlockedDownload = {
	/** The URL's host as written: a name, or the address itself. */
	host: string;
	address: string;
	/** What kind of address it is, as a phrase: "this machine", "your local network", ... */
	kind: string;
};

/** "mirror.lan (192.168.1.20)", or just the address when the URL named it. */
export function blockedLabel(blocked: Pick<BlockedDownload, 'host' | 'address'>): string {
	return blocked.host === blocked.address ? blocked.address : `${blocked.host} (${blocked.address})`;
}
