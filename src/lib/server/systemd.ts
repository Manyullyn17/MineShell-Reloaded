import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	INSTANCES_DIR,
	TEMPLATE_UNIT,
	UNITS_DIR,
	UNIT_PREFIX,
	ensureDirs,
	systemdUnitDir,
	unitEnvFile,
	unitName
} from './config';
import { installedTemplateUnit, renderTemplateUnit as renderTemplate } from './unit-template.js';

const TEMPLATE_PATHS = { prefix: UNIT_PREFIX, instancesDir: INSTANCES_DIR, unitsDir: UNITS_DIR };

export type UnitState = {
	/** active | inactive | failed | activating | deactivating | unknown */
	active: string;
	/** running | dead | exited | failed | start-pre | auto-restart | ... */
	sub: string;
	/** UNIX ms of the current activation, 0 when not running. */
	activeEnterTimestamp: number;
	cpuUsageNsec: number;
	memoryBytes: number;
	mainPid: number;
	nRestarts: number;
	result: string;
};

export const UNKNOWN_STATE: UnitState = {
	active: 'unknown',
	sub: 'unknown',
	activeEnterTimestamp: 0,
	cpuUsageNsec: 0,
	memoryBytes: 0,
	mainPid: 0,
	nRestarts: 0,
	result: 'unknown'
};

/** System boot wall-clock time, needed to turn systemd's monotonic stamps into dates. */
let bootTimeMs = 0;
function systemBootTimeMs(): number {
	if (bootTimeMs) return bootTimeMs;
	try {
		const uptimeSec = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
		bootTimeMs = Date.now() - uptimeSec * 1000;
	} catch {
		bootTimeMs = Date.now();
	}
	return bootTimeMs;
}

export type RunResult = { code: number; stdout: string; stderr: string };

export function run(argv: string[], opts: { timeoutMs?: number; cwd?: string } = {}) {
	return new Promise<RunResult>((resolve) => {
		const [cmd, ...args] = argv;
		const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
		child.stdout.on('data', (d) => (stdout += d.toString()));
		child.stderr.on('data', (d) => (stderr += d.toString()));
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({ code: 127, stdout, stderr: stderr + String(err) });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

export async function systemctl(...args: string[]): Promise<RunResult> {
	return run(['systemctl', '--user', ...args]);
}

/**
 * The template unit. Written once at setup and refreshed whenever MineShell's
 * data directory changes. Everything instance-specific lives in the per-instance
 * EnvironmentFile so a single unit file serves every server.
 */
export function renderTemplateUnit(): string {
	return renderTemplate(TEMPLATE_PATHS);
}

/**
 * Restart= cannot come from an EnvironmentFile, so the policy is baked per
 * instance via a drop-in directory instead of into the shared template.
 */
function renderRestartDropIn(policy: 'on-failure' | 'no', limit: number, windowSec: number): string {
	return `# Managed by MineShell
[Unit]
StartLimitIntervalSec=${windowSec}
StartLimitBurst=${limit}

[Service]
Restart=${policy}
`;
}

/** The template as installed: the Restart= placeholder filled, so it is valid without a drop-in. */
function installedTemplateContents(): string {
	return installedTemplateUnit(TEMPLATE_PATHS);
}

/**
 * At startup: an installed template from an older MineShell is rewritten,
 * so changes to it (SuccessExitStatus=143) reach existing setups without
 * pressing Install again. Only a file MineShell wrote is touched.
 */
export async function refreshTemplateUnit(): Promise<boolean> {
	const file = path.join(systemdUnitDir(), TEMPLATE_UNIT);
	const current = await fs.readFile(file, 'utf8').catch(() => null);
	if (!current || !current.startsWith('# Managed by MineShell') || current === installedTemplateContents()) return false;
	await fs.writeFile(file, installedTemplateContents(), 'utf8');
	await systemctl('daemon-reload');
	return true;
}

export async function installTemplateUnit(): Promise<{ ok: boolean; message: string }> {
	const dir = systemdUnitDir();
	try {
		await fs.mkdir(dir, { recursive: true });
		const contents = installedTemplateContents();
		await fs.writeFile(path.join(dir, TEMPLATE_UNIT), contents, 'utf8');
		const reload = await systemctl('daemon-reload');
		if (reload.code !== 0) {
			return { ok: false, message: reload.stderr.trim() || 'daemon-reload failed' };
		}
		return { ok: true, message: `Installed ${path.join(dir, TEMPLATE_UNIT)}` };
	} catch (err) {
		return { ok: false, message: String(err) };
	}
}

export async function templateUnitInstalled(): Promise<boolean> {
	try {
		await fs.access(path.join(systemdUnitDir(), TEMPLATE_UNIT));
		return true;
	} catch {
		return false;
	}
}

/** Write the per-instance EnvironmentFile that the template unit reads. */
export async function writeUnitEnv(
	id: string,
	values: {
		java: string;
		jvmArgs: string;
		launchArgs: string;
		extra?: Record<string, string>;
	}
): Promise<void> {
	ensureDirs();
	const lines = [
		'# Managed by MineShell. Edits here are overwritten when you save instance settings.',
		`MS_JAVA=${values.java}`,
		`MS_JVM_ARGS=${values.jvmArgs}`,
		`MS_LAUNCH_ARGS=${values.launchArgs}`
	];
	for (const [k, v] of Object.entries(values.extra ?? {})) lines.push(`${k}=${v}`);
	await fs.writeFile(unitEnvFile(id), lines.join('\n') + '\n', { mode: 0o600 });
}

export async function writeRestartPolicy(
	id: string,
	enabled: boolean,
	limit: number,
	windowSec: number
): Promise<void> {
	// Without MineShell's template unit the drop-in would belong to no unit and
	// just litter the user's systemd folder. Installing the template re-syncs
	// every instance, so nothing is lost by waiting.
	if (!(await templateUnitInstalled())) return;
	const dropInDir = path.join(systemdUnitDir(), `${unitName(id)}.d`);
	await fs.mkdir(dropInDir, { recursive: true });
	await fs.writeFile(
		path.join(dropInDir, 'restart.conf'),
		renderRestartDropIn(enabled ? 'on-failure' : 'no', limit, windowSec),
		'utf8'
	);
	await systemctl('daemon-reload');
}

export function renderLimitsDropIn(limits: { memoryMb: number | null; cpuPercent: number | null }): string | null {
	const lines: string[] = [];
	// Past MemoryMax the kernel kills the server, so this is a hard cap; the
	// settings page keeps it above the Java heap.
	if (limits.memoryMb) lines.push(`MemoryMax=${limits.memoryMb}M`);
	if (limits.cpuPercent) lines.push(`CPUQuota=${limits.cpuPercent}%`);
	return lines.length ? `# Managed by MineShell\n[Service]\n${lines.join('\n')}\n` : null;
}

/**
 * Per-server memory and CPU caps as a limits.conf drop-in, removed when
 * neither is set. User units can be capped where the user manager has the
 * memory and cpu controllers delegated (the systemd default).
 */
export async function writeResourceLimits(id: string, limits: { memoryMb: number | null; cpuPercent: number | null }): Promise<void> {
	if (!(await templateUnitInstalled())) return;
	const dropInDir = path.join(systemdUnitDir(), `${unitName(id)}.d`);
	const file = path.join(dropInDir, 'limits.conf');
	const body = renderLimitsDropIn(limits);
	const current = await fs.readFile(file, 'utf8').catch(() => null);
	if (body === current) return;
	if (body) {
		await fs.mkdir(dropInDir, { recursive: true });
		await fs.writeFile(file, body, 'utf8');
	} else {
		await fs.rm(file, { force: true });
	}
	await systemctl('daemon-reload');
}

export async function removeUnitArtifacts(id: string): Promise<void> {
	await systemctl('disable', '--now', unitName(id)).catch(() => undefined);
	await fs.rm(path.join(systemdUnitDir(), `${unitName(id)}.d`), {
		recursive: true,
		force: true
	});
	await fs.rm(unitEnvFile(id), { force: true });
	await systemctl('reset-failed', unitName(id)).catch(() => undefined);
	await systemctl('daemon-reload');
	invalidateUnitState(id);
}

const SHOW_PROPS = [
	'ActiveState',
	'SubState',
	'ActiveEnterTimestampMonotonic',
	'CPUUsageNSec',
	'MemoryCurrent',
	'MainPID',
	'NRestarts',
	'Result'
];

function parseShow(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split('\n')) {
		const idx = line.indexOf('=');
		if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
	}
	return out;
}

function num(value: string | undefined): number {
	if (!value || value === '[not set]' || value === 'infinity') return 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Every page load asks for the state of every instance, the dashboard
 * revalidates on a timer, and the monitor polls on its own. Without a cache
 * that is one forked `systemctl` per instance per request. The window is short
 * enough that nothing looks stale, and anything that changes state clears it.
 */
const STATE_CACHE_MS = 1500;
const stateCache = new Map<string, { at: number; pending: Promise<UnitState> }>();

export function invalidateUnitState(id?: string): void {
	if (id) stateCache.delete(id);
	else stateCache.clear();
}

async function readUnitState(id: string): Promise<UnitState> {
	const res = await systemctl('show', unitName(id), ...SHOW_PROPS.map((p) => `-p${p}`));
	if (res.code !== 0 && !res.stdout) return { ...UNKNOWN_STATE };
	const props = parseShow(res.stdout);
	// Monotonic timestamps are relative to boot; convert to wall clock.
	const monotonic = num(props.ActiveEnterTimestampMonotonic);
	return {
		active: props.ActiveState || 'unknown',
		sub: props.SubState || 'unknown',
		activeEnterTimestamp: monotonic > 0 ? systemBootTimeMs() + monotonic / 1000 : 0,
		cpuUsageNsec: num(props.CPUUsageNSec),
		memoryBytes: num(props.MemoryCurrent),
		mainPid: num(props.MainPID),
		nRestarts: num(props.NRestarts),
		result: props.Result || 'unknown'
	};
}

export async function unitState(id: string, options: { fresh?: boolean } = {}): Promise<UnitState> {
	const cached = stateCache.get(id);
	// The promise is cached rather than the value, so simultaneous callers
	// (several open tabs, say) share a single subprocess instead of racing.
	if (!options.fresh && cached && Date.now() - cached.at < STATE_CACHE_MS) {
		return cached.pending;
	}

	const pending = readUnitState(id).catch((err) => {
		stateCache.delete(id);
		throw err;
	});
	stateCache.set(id, { at: Date.now(), pending });
	return pending;
}

export async function startUnit(id: string) {
	invalidateUnitState(id);
	const res = await systemctl('start', unitName(id));
	invalidateUnitState(id);
	return res;
}
export async function stopUnit(id: string) {
	invalidateUnitState(id);
	const res = await systemctl('stop', unitName(id));
	invalidateUnitState(id);
	return res;
}
export async function restartUnit(id: string) {
	invalidateUnitState(id);
	const res = await systemctl('restart', unitName(id));
	invalidateUnitState(id);
	return res;
}
export async function enableUnit(id: string, enabled: boolean) {
	return systemctl(enabled ? 'enable' : 'disable', unitName(id));
}
export async function isUnitEnabled(id: string): Promise<boolean> {
	const res = await systemctl('is-enabled', unitName(id));
	return res.stdout.trim() === 'enabled';
}
export async function resetFailed(id: string) {
	invalidateUnitState(id);
	return systemctl('reset-failed', unitName(id));
}

/** Quick environment probe used by the setup and settings pages. */
export async function probeSystemd(): Promise<{
	available: boolean;
	version: string;
	message: string;
}> {
	const res = await systemctl('--version');
	const available = res.code === 0;
	const version = res.stdout.split('\n')[0] ?? '';
	return {
		available,
		version,
		message: available ? '' : res.stderr.trim() || 'systemctl not reachable'
	};
}
