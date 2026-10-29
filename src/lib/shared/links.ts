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
 * A link to another site as data gives it (a project page from a platform or
 * the modpacks.ch mirror, a download a pack lists), or null for anything but
 * http(s): a "javascript:" URL in an href runs in MineShell's page when
 * clicked, and Svelte does not stop it.
 */
export function webLink(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
	} catch {
		return null;
	}
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

/**
 * Whether `pathname` is the page at `base` or one below it. A bare
 * startsWith also matched siblings sharing the prefix: a server's copy,
 * `/instances/pack-copy`, lit up `/instances/pack` in the sidebar too.
 */
export function isUnder(pathname: string, base: string): boolean {
	return pathname === base || pathname.startsWith(`${base}/`);
}
