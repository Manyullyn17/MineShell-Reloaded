/**
 * How a page reached the browser: over https, from this machine itself, or as plain http
 * across the network, where a password and the session cookie can be read by anyone on the
 * way (the LAN's other devices, a public network's). Read in the browser, from `location`:
 * behind Tailscale or a proxy that ends TLS, MineShell itself only ever sees http.
 */
export type Connection = 'https' | 'local' | 'plain';

export function connectionKind(location: { protocol: string; hostname: string }): Connection {
	if (location.protocol === 'https:') return 'https';
	const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)) return 'local';
	return 'plain';
}

/** DEPLOYMENT's section on reaching MineShell from elsewhere, for pages without Settings (sign-in, setup). */
export const REMOTE_ACCESS_DOCS = 'https://github.com/Manyullyn17/MineShell-Reloaded/blob/main/docs/DEPLOYMENT.md#remote-access';
