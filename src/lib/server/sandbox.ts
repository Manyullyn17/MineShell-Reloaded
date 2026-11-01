import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DATA_DIR, DB_PATH, KEY_PATH, SANDBOX_ENABLED, TMP_DIR, instanceDir, systemdUnitDir, unitName } from './config';
import { MANAGED_JAVA_DIR } from './javadownload';
import { run, systemctl, templateUnitInstalled } from './systemd';

/**
 * Every server runs as the account MineShell runs as, so without more a mod
 * could do anything that account can: read MineShell's database and key (and
 * so sign in as anyone), change the other servers, MineShell itself or
 * ~/.ssh, or ask the systemd user manager to start any program outside every
 * limit. Mods are code from the internet, and packs bring hundreds of them.
 *
 * So each server gets a sandbox drop-in (`<unit>.d/sandbox.conf`): the whole
 * file system read-only, home folders (and /run/user, where the user manager's
 * sockets are) replaced by an empty one, and only its own folder and its Java
 * put back in. systemd builds that in a user namespace of its own, which some
 * kernels refuse to user units (Ubuntu's AppArmor restriction on unprivileged
 * user namespaces, a sysctl turning them off): a server given the drop-in
 * there would not start at all. So MineShell first starts a throwaway unit
 * with the same settings and checks it sees only what it should; only then
 * are the drop-ins written. `MINESHELL_SANDBOX=off` leaves them out.
 *
 * What stays possible: the network (a server can reach MineShell's port and
 * the other servers' RCON like anyone on the machine, which is why
 * MINESHELL_AUTH=off is for trusted machines only), reading the system's own
 * files, and links in the server folder, which MineShell does not follow out
 * of it (files.ts, safeJoin).
 */

export type SandboxState = { on: boolean; reason: string };

/** Where the data folder hides already: ProtectHome=tmpfs covers these. */
const HIDDEN_ROOTS = ['/home', '/root', '/run/user'];
/** Paths written into the drop-in as they are: anything that would need quoting or escaping in a unit file is not sandboxed. */
const PLAIN_PATH = /^\/[A-Za-z0-9_.@+/-]*$/;

const under = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/** The settings, as [name, value] pairs: one list for the drop-in and for the probe, so the probe tries exactly what servers get. */
export function sandboxProperties(opts: { serverDir: string; javaHomes: string[]; dataDir?: string }): [string, string][] {
	const dataDir = opts.dataDir ?? DATA_DIR;
	return [
		['ProtectSystem', 'strict'],
		['ProtectHome', 'tmpfs'],
		// A data folder outside the home folders (/srv/mineshell) is emptied the same way.
		...(HIDDEN_ROOTS.some((root) => under(root, dataDir)) ? [] : [['TemporaryFileSystem', `${dataDir}:ro`] as [string, string]]),
		['PrivateTmp', 'yes'],
		['PrivateDevices', 'yes'],
		['ProtectKernelTunables', 'yes'],
		['ProtectKernelModules', 'yes'],
		['ProtectControlGroups', 'yes'],
		['RestrictSUIDSGID', 'yes'],
		['LockPersonality', 'yes'],
		['NoNewPrivileges', 'yes'],
		['BindPaths', opts.serverDir],
		// `-`: a Java that is gone is the start's error to report, not the sandbox's.
		...opts.javaHomes.map((home) => ['BindReadOnlyPaths', `-${home}`] as [string, string])
	];
}

export function renderSandboxDropIn(properties: [string, string][]): string {
	return `# Managed by MineShell: this server sees its own folder, its Java and the system
# (read-only), not the rest of this account's files. MINESHELL_SANDBOX=off turns it off.
[Service]
${properties.map(([name, value]) => `${name}=${value}`).join('\n')}
`;
}

/** The folder a Java binary belongs to (…/bin/java -> …), through any links, as servers need all of it. */
export function javaHome(binary: string): string {
	let real = binary;
	try {
		real = realpathSync(binary);
	} catch {
		// Reported at start.
	}
	return path.dirname(path.dirname(real));
}

let known: { state: SandboxState; at: number } | null = null;
/** A failed probe is tried again after this: the user manager may just have been busy. */
const RETRY_MS = 10 * 60_000;

/** Whether servers run sandboxed here, probing once (and again after a failure). */
export async function sandboxState(): Promise<SandboxState> {
	if (!SANDBOX_ENABLED) return { on: false, reason: 'Turned off with MINESHELL_SANDBOX=off.' };
	if (known && (known.state.on || Date.now() - known.at < RETRY_MS)) return known.state;
	const state = await probe();
	known = { state, at: Date.now() };
	if (!state.on) console.warn(`[mineshell] servers run without a sandbox: ${state.reason}`);
	return state;
}

/** For tests. */
export function forgetSandboxState(): void {
	known = null;
}

/**
 * A throwaway unit with the servers' sandbox, on a folder of its own: it must
 * start, write to its folder, and see neither MineShell's key nor its
 * database nor the user manager's sockets.
 */
async function probe(): Promise<SandboxState> {
	if (!PLAIN_PATH.test(DATA_DIR)) return { on: false, reason: `The data folder's path (${DATA_DIR}) has characters a unit file would need escaped.` };
	const dir = path.join(TMP_DIR, 'sandbox-probe');
	await fs.rm(dir, { recursive: true, force: true });
	await fs.mkdir(dir, { recursive: true });
	const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}`;
	const hidden = [KEY_PATH, DB_PATH, runtime, path.join(homedir(), '.ssh')];
	const script = path.join(dir, 'check.sh');
	await fs.writeFile(
		script,
		[`touch '${dir}/written' || exit 10`, ...hidden.map((p, i) => `if [ -e '${p}' ]; then exit ${11 + i}; fi`), 'exit 0'].join('\n') + '\n'
	);
	// The script has to stay readable inside, so it is in the folder the sandbox shows.
	const props = sandboxProperties({ serverDir: dir, javaHomes: [] });
	const res = await run(
		['systemd-run', '--user', '--wait', '--quiet', '--collect', ...props.flatMap(([k, v]) => ['-p', `${k}=${v}`]), '/bin/sh', script],
		{ timeoutMs: 30_000 }
	);
	const written = await fs.access(path.join(dir, 'written')).then(
		() => true,
		() => false
	);
	await fs.rm(dir, { recursive: true, force: true });
	if (res.code === 0 && written) return { on: true, reason: 'Each server sees only its own folder, its Java and the system.' };
	if (res.code >= 11 && res.code < 11 + hidden.length) {
		return { on: false, reason: `A sandboxed test unit could still see ${hidden[res.code - 11]}.` };
	}
	const said = (res.stderr || res.stdout).trim().split('\n').slice(-2).join(' ');
	return {
		on: false,
		reason: `systemd could not start a sandboxed test unit${said ? ` (${said})` : ` (exit ${res.code})`}. On Ubuntu this is usually the AppArmor restriction on unprivileged user namespaces.`
	};
}

/**
 * Writes (or removes) a server's sandbox drop-in before its start. Returns a
 * warning for the person starting it: a link in its folder to elsewhere (a
 * world on another disk) is not reachable from inside.
 */
export async function writeSandbox(id: string, javaBinary: string): Promise<{ warning: string | null }> {
	if (!(await templateUnitInstalled())) return { warning: null };
	const file = path.join(systemdUnitDir(), `${unitName(id)}.d`, 'sandbox.conf');
	const current = await fs.readFile(file, 'utf8').catch(() => null);
	const state = await sandboxState();
	const serverDir = instanceDir(id);
	const homes = [...new Set([MANAGED_JAVA_DIR, javaHome(javaBinary)])];
	const plain = [serverDir, ...homes].every((p) => PLAIN_PATH.test(p));
	const body = state.on && plain ? renderSandboxDropIn(sandboxProperties({ serverDir, javaHomes: homes })) : null;
	if (body !== current) {
		if (body) {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, body, 'utf8');
		} else {
			await fs.rm(file, { force: true });
		}
		await systemctl('daemon-reload');
	}
	if (!body) return { warning: null };
	const leaving = await linksOut(serverDir);
	return {
		warning: leaving.length
			? `${leaving.join(', ')} ${leaving.length === 1 ? 'links' : 'link'} out of the server folder, which the sandbox does not show the server: move ${leaving.length === 1 ? 'it' : 'them'} into the folder, or set MINESHELL_SANDBOX=off.`
			: null
	};
}

/** Top-level entries of a server folder that are links to somewhere outside it. */
async function linksOut(dir: string): Promise<string[]> {
	const out: string[] = [];
	const real = await fs.realpath(dir).catch(() => dir);
	for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isSymbolicLink()) continue;
		const target = await fs.realpath(path.join(dir, entry.name)).catch(() => null);
		if (target && !under(real, target)) out.push(entry.name);
	}
	return out;
}
