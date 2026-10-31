#!/usr/bin/env node
/**
 * Checks the things that silently break a self-hosted setup: systemd reachability,
 * lingering, journal access, Java, whether the data directory is writable, and whether
 * systemd can sandbox the servers.
 *
 *   npm run doctor
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);

/**
 * Minimal .env reader. The app itself gets .env loaded automatically by Vite,
 * but these scripts run as plain Node and would otherwise silently fall back to
 * defaults - which is how a unit file ends up pointing at the wrong data
 * directory while everything looks like it worked.
 */
function loadDotenv(dir = process.cwd()) {
	// MINESHELL_ENV_FILE: an installed MineShell's config (the installer sets it).
	const file = process.env.MINESHELL_ENV_FILE || path.join(dir, '.env');
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return {}; // no .env is fine; real env vars and defaults still apply
	}

	const values = {};
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		// Strip matching surrounding quotes, if present.
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
			(value.startsWith("'") && value.endsWith("'") && value.length > 1)
		) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}

	// A real environment variable always wins over the file, matching how
	// Vite treats .env - so `MINESHELL_DATA=/tmp/x npm run setup` still works.
	for (const [key, value] of Object.entries(values)) {
		if (process.env[key] === undefined) process.env[key] = value;
	}
	return values;
}

loadDotenv();
// `||`, as config.ts reads them: an empty value means the default there too.
const PREFIX = process.env.MINESHELL_UNIT_PREFIX || 'minecraft';
const DATA_DIR = path.resolve(
	process.env.MINESHELL_DATA ||
		path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'mineshell')
);

const results = [];
/** `warn`: worth fixing, but nothing breaks without it; not counted as a failure. */
function record(ok, label, detail = '', warn = false) {
	results.push({ ok, label, detail, warn });
}

async function tryRun(cmd, args) {
	try {
		const { stdout } = await run(cmd, args);
		return { ok: true, stdout };
	} catch (err) {
		return { ok: false, stdout: '', error: err.message };
	}
}

async function main() {
	// package.json's engines.node, e.g. ">=22.19". A distro's own Node is often older
	// (Ubuntu 24.04 ships 18), and the service unit runs whatever /usr/bin/node is.
	const engines = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines?.node ?? '';
	const [wantMajor = 0, wantMinor = 0] = (engines.match(/\d+(\.\d+)?/)?.[0] ?? '0').split('.').map(Number);
	const [major, minor] = process.versions.node.split('.').map(Number);
	const ok = major > wantMajor || (major === wantMajor && minor >= wantMinor);
	record(ok, `Node.js ${process.versions.node}`, ok ? '' : `MineShell needs Node.js ${wantMajor}.${wantMinor} or newer (${process.execPath}).`);

	const version = await tryRun('systemctl', ['--user', '--version']);
	record(version.ok, 'systemctl reachable (user units)', version.ok ? version.stdout.split('\n')[0] : version.error);

	const journal = await tryRun('journalctl', ['--version']);
	record(journal.ok, 'journalctl available', journal.ok ? '' : 'Console output will not work.');

	const linger = await tryRun('loginctl', ['show-user', process.env.USER ?? '', '-p', 'Linger', '--value']);
	const enabled = linger.stdout.trim() === 'yes';
	record(enabled, 'Lingering enabled', enabled ? '' : `Run: loginctl enable-linger ${process.env.USER}`);

	const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'systemd', 'user');
	const unitPath = path.join(unitDir, `${PREFIX}@.service`);
	const unitExists = await fs.access(unitPath).then(() => true, () => false);
	record(unitExists, 'Template unit installed', unitExists ? unitPath : 'Run: npm run setup');

	try {
		await fs.mkdir(DATA_DIR, { recursive: true });
		await fs.access(DATA_DIR, (await import('node:fs')).constants.W_OK);
		record(true, 'Data directory writable', DATA_DIR);
	} catch (err) {
		record(false, 'Data directory writable', `${DATA_DIR}: ${err.message}`);
	}

	// Also the runtimes MineShell downloaded itself (javadownload.ts). None is fine: a server
	// that needs one offers the download.
	const java = await tryRun('sh', ['-c', 'ls -d "$1"/*/bin/java /usr/lib/jvm/*/bin/java 2>/dev/null; command -v java; true', 'sh', path.join(DATA_DIR, 'java')]);
	const javas = java.stdout.trim().split('\n').filter(Boolean);
	record(true, 'Java', javas.join(', ') || 'none yet: a server that needs one offers to download it (MineShell settings > Java), or install a JRE, e.g. openjdk-21-jre-headless');

	// systemd ignores PrivateTmp= and the like without a word when it cannot make the user
	// namespace they need in a user unit (Ubuntu 23.10+ lets AppArmor refuse it); the server
	// then shares this account's mount namespace. DEPLOYMENT.md, "Sandboxing the servers".
	if (version.ok) {
		const own = await fs.readlink('/proc/self/ns/mnt').catch(() => '');
		const probe = await tryRun('systemd-run', ['--user', '--wait', '--pipe', '--quiet', '-p', 'PrivateTmp=yes', 'readlink', '/proc/self/ns/mnt']);
		const sandboxed = probe.ok && probe.stdout.trim() !== '' && probe.stdout.trim() !== own;
		const restricted = (await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() === '1';
		const fix = restricted
			? 'AppArmor keeps systemd from making user namespaces. See DEPLOYMENT.md, "Sandboxing the servers", for the fix (needs sudo once).'
			: 'systemd ignores PrivateTmp= in user units here (no user namespaces?). See DEPLOYMENT.md, "Sandboxing the servers".';
		record(sandboxed, 'systemd can sandbox servers', sandboxed ? '' : fix, true);
	}

	console.log('');
	for (const r of results) {
		console.log(`${r.ok ? ' ok ' : r.warn ? 'warn' : 'FAIL'}  ${r.label}${r.detail ? `\n        ${r.detail}` : ''}`);
	}
	console.log('');
	const failures = results.filter((r) => !r.ok && !r.warn).length;
	if (failures) {
		console.log(`${failures} check${failures === 1 ? '' : 's'} need attention.`);
		process.exitCode = 1;
	} else {
		const warnings = results.filter((r) => !r.ok).length;
		console.log(warnings ? `Everything works; ${warnings === 1 ? 'one warning' : `${warnings} warnings`} above.` : 'Everything looks ready.');
	}
}

main();
