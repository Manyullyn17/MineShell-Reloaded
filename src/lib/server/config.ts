import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as env from '$app/env/private';

function defaultDataDir(): string {
	const xdg = env.XDG_DATA_HOME || process.env.XDG_DATA_HOME;
	if (xdg) return path.join(xdg, 'mineshell');
	return path.join(homedir(), '.local', 'share', 'mineshell');
}

export const DATA_DIR = path.resolve(env.MINESHELL_DATA || defaultDataDir());
export const INSTANCES_DIR = path.join(DATA_DIR, 'instances');
export const UNITS_DIR = path.join(DATA_DIR, 'units');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const DB_PATH = path.join(DATA_DIR, 'mineshell.db');
export const KEY_PATH = path.join(DATA_DIR, 'secret.key');

export const UNIT_PREFIX = env.MINESHELL_UNIT_PREFIX || 'minecraft';
export const TEMPLATE_UNIT = `${UNIT_PREFIX}@.service`;

export const AUTH_ENABLED = (env.MINESHELL_AUTH ?? 'on').toLowerCase() !== 'off';

export const CURSEFORGE_API_KEY = env.CURSEFORGE_API_KEY || '';

/**
 * Where the systemd user units live. Servers always run as user units of the
 * account MineShell runs as: no root, nothing in /etc (system scope with sudo
 * rules was removed in October 2026; it ran every server as root).
 */
export function systemdUnitDir(): string {
	const xdgConfig = env.XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
	return path.join(xdgConfig, 'systemd', 'user');
}

let ensured = false;
/** Create the data directory tree. Cheap and idempotent. */
export function ensureDirs(): void {
	if (ensured) return;
	for (const dir of [DATA_DIR, INSTANCES_DIR, UNITS_DIR, CACHE_DIR, TMP_DIR]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	ensured = true;
}

export function instanceDir(id: string): string {
	return path.join(INSTANCES_DIR, id);
}

export function unitEnvFile(id: string): string {
	return path.join(UNITS_DIR, `${id}.env`);
}

/** JVM arguments for the next start only; the unit's start command reads and deletes it. */
export function unitOnceArgsFile(id: string): string {
	return path.join(UNITS_DIR, `${id}.once`);
}

export function unitName(id: string): string {
	return `${UNIT_PREFIX}@${id}.service`;
}
