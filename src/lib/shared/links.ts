/**
 * Descriptions are written for the platform's own site, so their links
 * assume they are on it. CurseForge wraps every outbound link in its own
 * redirector as a relative `/linkout?remoteUrl=...` (the target URL
 * encoded twice), and other relative links point at pages on the
 * platform. Rendered here both resolved against MineShell instead and
 * 404'd. Redirector links are unwrapped to their real target, other
 * relative links resolve against the project page, and anything that is
 * not http(s)/mailto is dropped.
 */
export function fixLink(href: string, base: string | null): string | null {
	if (href.startsWith('#')) return href;
	let url: URL;
	try {
		url = new URL(href, base ?? undefined);
	} catch {
		return null;
	}
	const remote = url.pathname === '/linkout' ? url.searchParams.get('remoteUrl') : null;
	if (remote) {
		let target = remote;
		for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(target); i++) {
			try {
				target = decodeURIComponent(target);
			} catch {
				break;
			}
		}
		return /^https?:\/\//i.test(target) ? target : null;
	}
	return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
}

/**
 * Where to send someone after login: `next` if it stays on this site, else
 * "/". Checking startsWith('/') is not enough - "//evil.example" and
 * "/\evil.example" are both read by browsers as another site.
 */
export function sameOriginPath(next: string | null | undefined, origin: string): string {
	if (!next) return '/';
	try {
		const url = new URL(next, origin);
		if (url.origin !== new URL(origin).origin) return '/';
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return '/';
	}
}
