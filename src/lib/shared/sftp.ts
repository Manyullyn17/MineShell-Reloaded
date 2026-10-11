/**
 * An sftp:// link to a folder on the machine MineShell runs on. File managers
 * (Nautilus, Dolphin, Finder with an SFTP helper, WinSCP, FileZilla) open
 * these, logging in with the machine's own SSH account; MineShell serves no
 * files itself.
 */
export function sftpLink(opts: { user: string; host: string; port: number; path: string }): string {
	// An IPv6 address goes in brackets, as in any URL.
	const host = opts.host.includes(':') && !opts.host.startsWith('[') ? `[${opts.host}]` : opts.host;
	const port = opts.port === 22 ? '' : `:${opts.port}`;
	const path = opts.path
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/');
	return `sftp://${encodeURIComponent(opts.user)}@${host}${port}${path.startsWith('/') ? path : `/${path}`}`;
}
