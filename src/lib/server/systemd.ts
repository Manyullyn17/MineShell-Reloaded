import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	DATA_DIR,
	INSTANCES_DIR,
	TEMPLATE_UNIT,
	UNITS_DIR,
	UNIT_PREFIX,
	ensureDirs,
	systemdUnitDir,
	unitEnvFile,
	unitName,
	unitOnceArgsFile,
	unitOnceDir
} from './config';
import { installedTemplateUnit, renderTemplateUnit as renderTemplate, serverSliceName, writeUnitIfChanged } from './unit-template.js';
import { shellQuote, unitEnvArgs } from './shellargs';

const TEMPLATE_PATHS = { prefix: UNIT_PREFIX, instancesDir: INSTANCES_DIR, unitsDir: UNITS_DIR };

/** The slice all servers run in (unit-template.js). */
export const SERVER_SLICE = serverSliceName(UNIT_PREFIX);

export type UnitState = {
	/** active | inactive | failed | activating | deactivating | unknown */
	active: string;
	/** running | dead | exited | failed | start-pre | auto-restart | ... */
	sub: string;
	/** UNIX ms of the current activation, 0 when not running. */
	activeEnterTimestamp: number;
	/** UNIX ms the running process started, so read its unit's settings; 0 when not running. */
	mainStartedAt: number;
	cpuUsageNsec: number;
	memoryBytes: number;
	mainPid: number;
	nRestarts: number;
	result: string;
	/** The unit's cgroup path, '' when it has none (stopped). */
	controlGroup: string;
	/** systemd's id of the current run (the journal's _SYSTEMD_INVOCATION_ID); '' when unknown. */
	invocation: string;
};

export const UNKNOWN_STATE: UnitState = {
	active: 'unknown',
	sub: 'unknown',
	activeEnterTimestamp: 0,
	mainStartedAt: 0,
	cpuUsageNsec: 0,
	memoryBytes: 0,
	mainPid: 0,
	nRestarts: 0,
	result: 'unknown',
	controlGroup: '',
	invocation: ''
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
		await writeUnitIfChanged(fs, path.join(dir, TEMPLATE_UNIT), installedTemplateContents());
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
	// systemd reads a backslash as an escape (`C:\games` arrived as `C:games`), and a
	// line break would start a line of its own, setting whatever it says.
	const value = (v: string) => v.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\');
	const lines = [
		'# Managed by MineShell. Edits here are overwritten when you save instance settings.',
		`MS_JAVA=${value(values.java)}`,
		// Quoted, read by the start line's eval: an argument may hold a space (shellargs.ts).
		`MS_JVM_ARGS=${unitEnvArgs(values.jvmArgs)}`,
		`MS_LAUNCH_ARGS=${unitEnvArgs(values.launchArgs)}`
	];
	for (const [k, v] of Object.entries(values.extra ?? {})) lines.push(`${k}=${value(v)}`);
	// Written only when it changes: its time says when the server's start last changed (startSettingsChangedAt).
	const body = lines.join('\n') + '\n';
	if ((await fs.readFile(unitEnvFile(id), 'utf8').catch(() => null)) === body) return;
	await fs.writeFile(unitEnvFile(id), body, { mode: 0o600 });
}

/**
 * When what a server's start reads last changed: the template unit (a MineShell update's new
 * sandbox options, its start line), its sandbox drop-in and its env file (Java, JVM and launch
 * arguments). A server running since before then runs without the change until it restarts.
 * Not restart.conf or limits.conf: systemd takes those on daemon-reload, running or not. Each
 * of the three is written only when its content changes, so a MineShell restart (which
 * rewrites every server's unit files) changes none of their times.
 */
export async function startSettingsChangedAt(id: string): Promise<number> {
	const files = [path.join(systemdUnitDir(), TEMPLATE_UNIT), path.join(systemdUnitDir(), `${unitName(id)}.d`, 'sandbox.conf'), unitEnvFile(id)];
	const times = await Promise.all(files.map((file) => fs.stat(file).then((s) => s.mtimeMs, () => 0)));
	return Math.max(...times);
}

/**
 * JVM arguments for the next start only, or none (null): the template's start
 * command reads <id>.once and deletes it, so a restart by systemd after a
 * crash, or any later start, runs without them. Every start through MineShell
 * sets this, so a file left by a start that never ran is not picked up later.
 */
export async function writeOnceArgs(id: string, args: string[] | null): Promise<void> {
	ensureDirs();
	// Read by the start line's eval, like MS_JVM_ARGS.
	if (args?.length) {
		await fs.mkdir(unitOnceDir(id), { recursive: true });
		await fs.writeFile(unitOnceArgsFile(id), args.map(shellQuote).join(' ') + '\n', { mode: 0o600 });
	} else await fs.rm(unitOnceArgsFile(id), { force: true });
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

let sandboxProbe: Promise<boolean> | null = null;

/**
 * Whether systemd can give this account's units a mount namespace of their own, asked once
 * per MineShell run with a transient unit (as `doctor` does): Ubuntu 23.10+ refuses it unless
 * DEPLOYMENT's AppArmor exception is in place, and a unit then runs without it silently, or
 * with some options (ProtectHome=, PrivateDevices=) fails to start at all (218/CAPABILITIES).
 * So the confinement below is written only where this says yes.
 */
export function canSandbox(): Promise<boolean> {
	sandboxProbe ??= (async () => {
		const own = await fs.readlink('/proc/self/ns/mnt').catch(() => '');
		const probe = await run(
			['systemd-run', '--user', '--wait', '--pipe', '--quiet', '-p', 'PrivateTmp=yes', '-p', 'ProtectHome=tmpfs', 'readlink', '/proc/self/ns/mnt'],
			{ timeoutMs: 15_000 }
		);
		const theirs = probe.stdout.trim();
		return probe.code === 0 && theirs !== '' && theirs !== own;
	})();
	return sandboxProbe;
}

/** For tests: ask again on the next call. */
export function forgetSandboxProbe(): void {
	sandboxProbe = null;
}

/**
 * The server kept to its own folder: the system read-only, home folders (and with them
 * MineShell's data, other servers, ~/.ssh) hidden but for the server's folder, its one-start
 * arguments and its Java. Only where `canSandbox`; null otherwise. Not ProtectProc=: it hides
 * other accounts' processes, and every process here is the same account's (whose files a
 * process in the server's user namespace cannot open through /proc anyway).
 * A data folder outside the home folders (MINESHELL_DATA=/srv/mineshell) is not covered by
 * ProtectHome=, and ProtectSystem=strict only makes it read-only: the database and secret.key
 * stay readable, so it is emptied the same way, the server's own parts put back over it.
 */
export function renderSandboxDropIn(paths: { instanceDir: string; onceDir: string; javaHome: string | null; dataDir?: string }): string {
	const dataDir = paths.dataDir ?? DATA_DIR;
	const hidden = ['/home', '/root', '/run/user'].some((root) => dataDir === root || dataDir.startsWith(root + '/'));
	const lines = [
		'# Managed by MineShell: the server sees only its own folder of this account\'s files',
		'# (ARCHITECTURE, "The servers\' sandbox"). Written only where systemd can make the',
		'# namespaces it needs; removed otherwise.',
		'[Service]',
		'ProtectSystem=strict',
		'ProtectHome=tmpfs',
		...(hidden ? [] : [`TemporaryFileSystem=${dataDir}:ro`]),
		`BindPaths=${paths.instanceDir}`,
		// "-": a path missing is skipped rather than failing the start.
		`BindPaths=-${paths.onceDir}`,
		...(paths.javaHome ? [`BindReadOnlyPaths=-${paths.javaHome}`] : []),
		'ProtectKernelTunables=yes',
		'ProtectKernelModules=yes',
		'ProtectKernelLogs=yes',
		'ProtectControlGroups=yes',
		'ProtectHostname=yes'
	];
	return lines.join('\n') + '\n';
}

/**
 * What a server's sandbox shows of its Java: the home a `.../bin/java` belongs to (it needs its
 * lib/ too), else the folder the binary is in. Never `/`: binding that back undid the whole
 * sandbox, as a Java outside a bin/ folder (two up from /tmp/x/java) did until 1.1.
 */
export function javaHomeOf(binary: string): string | null {
	const dir = path.dirname(binary);
	const home = path.basename(dir) === 'bin' ? path.dirname(dir) : dir;
	return home === path.parse(home).root ? null : home;
}

/**
 * Writes sandbox.conf for a server where systemd can apply it, and removes it where not.
 * Returns a warning for the start when a link at the top of the server folder leads out of
 * it (a world moved to another disk): inside the sandbox it leads nowhere. Its target is not
 * bound in for it, since a mod can make such a link too (`world -> ~/.ssh`).
 */
export async function writeSandbox(id: string, paths: { instanceDir: string; javaPath: string | null }): Promise<{ warning: string | null }> {
	if (!(await templateUnitInstalled())) return { warning: null };
	const dropInDir = path.join(systemdUnitDir(), `${unitName(id)}.d`);
	const file = path.join(dropInDir, 'sandbox.conf');
	await fs.mkdir(unitOnceDir(id), { recursive: true });
	// The folder Java runs from, through any links (/usr/bin/java).
	const javaHome = paths.javaPath ? await fs.realpath(paths.javaPath).then(javaHomeOf, () => null) : null;
	const body = (await canSandbox()) ? renderSandboxDropIn({ instanceDir: paths.instanceDir, onceDir: unitOnceDir(id), javaHome }) : null;
	const current = await fs.readFile(file, 'utf8').catch(() => null);
	if (body !== current) {
		if (body) {
			await fs.mkdir(dropInDir, { recursive: true });
			await fs.writeFile(file, body, 'utf8');
		} else {
			await fs.rm(file, { force: true });
		}
		await systemctl('daemon-reload');
	}
	const leaving = body ? await linksOut(paths.instanceDir) : [];
	if (!leaving.length) return { warning: null };
	const one = leaving.length === 1;
	return {
		warning: `${leaving.join(', ')} ${one ? 'is a link' : 'are links'} out of the server folder, which the sandbox does not let the server follow: move ${one ? 'it' : 'them'} into the folder, or mount the other disk there (DEPLOYMENT, "Sandboxing the servers").`
	};
}

/** Entries at the top of a server folder that are links to somewhere outside it. */
async function linksOut(dir: string): Promise<string[]> {
	const real = await fs.realpath(dir).catch(() => dir);
	const out: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isSymbolicLink()) continue;
		const target = await fs.realpath(path.join(dir, entry.name)).catch(() => null);
		if (target && target !== real && !target.startsWith(real + path.sep)) out.push(entry.name);
	}
	return out;
}

export async function removeUnitArtifacts(id: string): Promise<void> {
	await systemctl('disable', '--now', unitName(id)).catch(() => undefined);
	await fs.rm(path.join(systemdUnitDir(), `${unitName(id)}.d`), {
		recursive: true,
		force: true
	});
	await fs.rm(unitEnvFile(id), { force: true });
	await fs.rm(unitOnceDir(id), { recursive: true, force: true });
	await systemctl('reset-failed', unitName(id)).catch(() => undefined);
	await systemctl('daemon-reload');
	invalidateUnitState(id);
}

const SHOW_PROPS = [
	'ActiveState',
	'SubState',
	'ActiveEnterTimestampMonotonic',
	'ExecMainStartTimestampMonotonic',
	'CPUUsageNSec',
	'MemoryCurrent',
	'ControlGroup',
	'MainPID',
	'NRestarts',
	'Result',
	'InvocationID'
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

/**
 * A unit's memory as its working set: systemd's MemoryCurrent counts the
 * page cache of every file the server read (region files, mod jars), which
 * the kernel drops whenever memory is wanted - a render that read the world
 * showed gigabytes the server did not hold. The inactive part of that cache
 * comes off, as Docker and Kubernetes report it. `stat` is the cgroup's
 * memory.stat; without it MemoryCurrent stands.
 */
export function workingSet(current: number, stat: string | null): number {
	const inactive = Number(stat?.match(/^inactive_file (\d+)$/m)?.[1] ?? 0);
	return Math.max(0, current - inactive);
}

async function readUnitState(id: string): Promise<UnitState> {
	const res = await systemctl('show', unitName(id), ...SHOW_PROPS.map((p) => `-p${p}`));
	if (res.code !== 0 && !res.stdout) return { ...UNKNOWN_STATE };
	const props = parseShow(res.stdout);
	// Monotonic timestamps are relative to boot; convert to wall clock.
	const monotonic = num(props.ActiveEnterTimestampMonotonic);
	const mainStart = num(props.ExecMainStartTimestampMonotonic);
	return {
		active: props.ActiveState || 'unknown',
		sub: props.SubState || 'unknown',
		activeEnterTimestamp: monotonic > 0 ? systemBootTimeMs() + monotonic / 1000 : 0,
		mainStartedAt: mainStart > 0 ? systemBootTimeMs() + mainStart / 1000 : 0,
		cpuUsageNsec: num(props.CPUUsageNSec),
		memoryBytes: workingSet(
			num(props.MemoryCurrent),
			props.ControlGroup?.startsWith('/') && !props.ControlGroup.includes('..')
				? await fs.readFile(path.join('/sys/fs/cgroup', props.ControlGroup, 'memory.stat'), 'utf8').catch(() => null)
				: null
		),
		mainPid: num(props.MainPID),
		nRestarts: num(props.NRestarts),
		result: props.Result || 'unknown',
		invocation: props.InvocationID ?? '',
		controlGroup: props.ControlGroup ?? ''
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
/**
 * Ends the process at once: for one that a stop cannot end, since a stop only asks and a hung
 * JVM never answers. The stop job comes first, or Restart=on-failure would start it again, and
 * finishes off anything else in the unit. A killed unit is left `failed`; this was asked for,
 * so it reads as stopped, not as a crash. `--kill-whom=all` fails on user units (EINVAL) after
 * killing the main process.
 */
export async function killUnit(id: string) {
	invalidateUnitState(id);
	await systemctl('stop', '--no-block', unitName(id));
	const res = await systemctl('kill', '--signal=SIGKILL', '--kill-whom=main', unitName(id));
	for (let i = 0; i < 30; i++) {
		invalidateUnitState(id);
		const { active } = await unitState(id, { fresh: true });
		if (active === 'failed' || active === 'inactive') break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	await systemctl('reset-failed', unitName(id));
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
