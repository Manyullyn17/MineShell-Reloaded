#!/usr/bin/env node
/**
 * One-shot environment preparation: creates the data directories and installs
 * the systemd template unit. Safe to re-run; it overwrites the unit file and
 * reloads the daemon.
 *
 *   npm run setup
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
	const file = path.join(dir, '.env');
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

const DATA_DIR = path.resolve(
	process.env.MINESHELL_DATA ??
		path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'mineshell')
);
const SCOPE = process.env.MINESHELL_SYSTEMD_SCOPE === 'system' ? 'system' : 'user';
const PREFIX = process.env.MINESHELL_UNIT_PREFIX ?? 'minecraft';
const INSTANCES_DIR = path.join(DATA_DIR, 'instances');
const UNITS_DIR = path.join(DATA_DIR, 'units');

const unitDir =
	SCOPE === 'user'
		? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'systemd', 'user')
		: '/etc/systemd/system';

const unit = `# Managed by MineShell.
[Unit]
Description=Minecraft server (%i) managed by MineShell
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${INSTANCES_DIR}/%i
EnvironmentFile=${UNITS_DIR}/%i.env

ExecStart=/bin/sh -c 'exec "$MS_JAVA" $MS_JVM_ARGS $MS_LAUNCH_ARGS'

KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=180

Restart=on-failure
RestartSec=15

CPUAccounting=yes
MemoryAccounting=yes

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${PREFIX}-%i

NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
`;

async function main() {
	for (const dir of [DATA_DIR, INSTANCES_DIR, UNITS_DIR, path.join(DATA_DIR, 'cache'), path.join(DATA_DIR, 'tmp')]) {
		await fs.mkdir(dir, { recursive: true });
	}
	console.log(`Data directory ready:      ${DATA_DIR}`);

	const target = path.join(unitDir, `${PREFIX}@.service`);
	try {
		await fs.mkdir(unitDir, { recursive: true });
		await fs.writeFile(target, unit, 'utf8');
		console.log(`Unit file written:         ${target}`);
	} catch (err) {
		console.error(`Could not write ${target}: ${err.message}`);
		if (SCOPE === 'system') console.error('System scope needs root. Try: sudo npm run setup');
		process.exitCode = 1;
		return;
	}

	try {
		await run('systemctl', SCOPE === 'user' ? ['--user', 'daemon-reload'] : ['daemon-reload']);
		console.log('systemd reloaded.');
	} catch (err) {
		console.warn(`daemon-reload failed: ${err.message}`);
	}

	if (SCOPE === 'user') {
		console.log('');
		console.log('One more step so servers survive logout:');
		console.log(`  loginctl enable-linger ${process.env.USER ?? '$USER'}`);
	}
}

main();
