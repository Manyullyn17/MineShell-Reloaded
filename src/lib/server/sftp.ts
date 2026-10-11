import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';

/**
 * The Files tab's "Open in file manager" link (lib/shared/sftp.ts builds it):
 * SFTP through the machine's own SSH server, as the user MineShell runs as,
 * who owns the server folders. MineShell runs no FTP server of its own - that
 * would be a second login and, for plain FTP, passwords in the clear.
 */

const KEY = 'files.sftp';
const SSHD_CONFIG = '/etc/ssh/sshd_config';

export type SftpSettings = {
	enabled: boolean;
	/** Null: the host name the browser reached MineShell by. */
	host: string | null;
	/** Null: what sshd_config says, else 22. */
	port: number | null;
	/** Null: the account MineShell runs as. */
	user: string | null;
};

const DEFAULTS: SftpSettings = { enabled: true, host: null, port: null, user: null };

export function getSftpSettings(): SftpSettings {
	const raw = db.select().from(settings).where(eq(settings.key, KEY)).get()?.value;
	if (!raw) return DEFAULTS;
	try {
		const parsed = JSON.parse(raw) as Partial<SftpSettings>;
		return {
			enabled: parsed.enabled !== false,
			host: typeof parsed.host === 'string' && validHost(parsed.host) ? parsed.host : null,
			port: validPort(parsed.port) ? parsed.port : null,
			user: typeof parsed.user === 'string' && validUser(parsed.user) ? parsed.user : null
		};
	} catch {
		return DEFAULTS;
	}
}

export function saveSftpSettings(value: SftpSettings): void {
	const json = JSON.stringify(value);
	db.insert(settings).values({ key: KEY, value: json }).onConflictDoUpdate({ target: settings.key, set: { value: json } }).run();
}

export const validPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536;
/** A host name or an IP address; no scheme, path or credentials. */
export const validHost = (host: string) => /^(\[[0-9a-f:.]+\]|[0-9a-f:]*:[0-9a-f:.]+|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/i.test(host);
export const validUser = (user: string) => /^[a-z_][a-z0-9_.-]*\$?$/i.test(user);

/**
 * The first Port in an sshd_config, as sshd reads it: keywords ignore case,
 * `#` starts a comment, and a Match block only applies to some connections,
 * so nothing after the first Match counts.
 */
export function sshdPort(config: string): number | null {
	for (const line of config.split('\n')) {
		const words = line.replace(/#.*/, '').trim().split(/\s+/);
		const keyword = words[0]?.toLowerCase();
		if (keyword === 'match') return null;
		if (keyword === 'port' && validPort(Number(words[1]))) return Number(words[1]);
	}
	return null;
}

/**
 * sshd's port from its config, drop-ins first (sshd keeps the first value it
 * reads, and the stock config includes sshd_config.d/*.conf at the top).
 * Files this user cannot read are skipped; nothing found means 22.
 */
async function detectedPort(): Promise<number> {
	const dropIns = await fs.readdir(`${SSHD_CONFIG}.d`).catch(() => [] as string[]);
	for (const name of dropIns.filter((n) => n.endsWith('.conf')).sort()) {
		const port = sshdPort(await fs.readFile(path.join(`${SSHD_CONFIG}.d`, name), 'utf8').catch(() => ''));
		if (port) return port;
	}
	return sshdPort(await fs.readFile(SSHD_CONFIG, 'utf8').catch(() => '')) ?? 22;
}

/** Whether something answers on the port here; false means the link will not work. */
function listening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 500 });
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(false));
		socket.once('error', () => done(false));
	});
}

export type SftpAccess = { user: string; host: string | null; port: number; reachable: boolean };

let cached: { at: number; setting: number | null; port: number; reachable: boolean } | null = null;

/** What the Files tab links to, or null when the link is turned off. */
export async function sftpAccess(): Promise<SftpAccess | null> {
	const s = getSftpSettings();
	if (!s.enabled) return null;
	if (!cached || Date.now() - cached.at > 60_000 || s.port !== cached.setting) {
		const port = s.port ?? (await detectedPort());
		cached = { at: Date.now(), setting: s.port, port, reachable: await listening(port) };
	}
	return { user: s.user ?? os.userInfo().username, host: s.host, port: cached.port, reachable: cached.reachable };
}

/** For the settings page: what the blank fields stand for. */
export async function sftpDefaults(): Promise<{ user: string; port: number }> {
	return { user: os.userInfo().username, port: await detectedPort() };
}
