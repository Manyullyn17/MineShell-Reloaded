import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as env from '$app/env/private';
import { db } from './db';
import { settings } from './db/schema';
import { TMP_DIR } from './config';
import { downloadFile, fetchJson, fetchText } from './download';
import { listOperations } from './operations';
import { run } from './systemd';
import { listTasks, startTask } from './tasks';

/**
 * MineShell updating itself from its GitHub releases (DEPLOYMENT.md, "Upgrading").
 *
 * Only an installed MineShell (scripts/install.sh) can: the installer writes its
 * folder, settings file and service name into the service's environment. The
 * update downloads the release archive, checks it against the published
 * SHA-256 and runs the install.sh inside it as a transient unit of its own
 * (`systemd-run --user`): the installer restarts this service, which would kill
 * anything it had started itself. Whether it worked is settled by the restarted
 * MineShell (settleUpdateRun), or, when the installer failed before restarting
 * anything, by the unit having ended (updateRunState).
 */

export const UPDATE_REPO = 'Manyullyn17/MineShell-Reloaded';
const CHECK_EVERY_MS = 12 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const TICK_MS = 60 * 60_000;
const CHECK_KEY = 'update.check';
const RUN_KEY = 'update.run';
const AUTO_KEY = 'update.autoCheck';

export type Release = {
	tag: string;
	version: string;
	name: string;
	notes: string;
	url: string;
	publishedAt: string;
	archiveUrl: string;
	checksumUrl: string;
};
export type UpdateCheck = { checkedAt: number; latest: Release | null; error: string | null };
export type UpdateRun = {
	from: string;
	to: string;
	unit: string;
	startedAt: number;
	outcome: 'running' | 'done' | 'failed';
	finishedAt: number | null;
	log: string[];
};
export type Install = { home: string; config: string; service: string };

export class UpdateRefused extends Error {}

export function currentVersion(): string {
	return __MINESHELL_VERSION__;
}

/** Where the installer put this MineShell; null when it runs from a source checkout. */
export function installInfo(): Install | null {
	const home = env.MINESHELL_INSTALL_HOME;
	const config = env.MINESHELL_INSTALL_CONFIG;
	const service = env.MINESHELL_INSTALL_SERVICE;
	return home && config && service ? { home, config, service } : null;
}

/** 1 when a is newer than b, -1 when older, 0 when equal ("1.2.3"; a leading v is ignored). */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
	}
	return 0;
}

function readJson<T>(key: string): T | null {
	const value = db.select().from(settings).where(eq(settings.key, key)).get()?.value;
	if (!value) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	const text = JSON.stringify(value);
	db.insert(settings).values({ key, value: text }).onConflictDoUpdate({ target: settings.key, set: { value: text } }).run();
}

export function autoCheckEnabled(): boolean {
	return readJson<boolean>(AUTO_KEY) ?? true;
}

export function setAutoCheck(on: boolean): void {
	writeJson(AUTO_KEY, on);
}

export function lastCheck(): UpdateCheck | null {
	return readJson<UpdateCheck>(CHECK_KEY);
}

type GithubRelease = {
	tag_name: string;
	name: string | null;
	body: string | null;
	html_url: string;
	published_at: string;
	draft: boolean;
	prerelease: boolean;
	assets: { name: string; browser_download_url: string }[];
};

function toRelease(raw: GithubRelease): Release {
	const version = raw.tag_name.replace(/^v/, '');
	const asset = (name: string) => raw.assets.find((a) => a.name === name)?.browser_download_url;
	const archiveUrl = asset(`mineshell-${version}.tar.gz`);
	const checksumUrl = asset(`mineshell-${version}.tar.gz.sha256`);
	if (!archiveUrl || !checksumUrl) throw new Error(`Release ${raw.tag_name} has no mineshell-${version}.tar.gz with its checksum.`);
	return {
		tag: raw.tag_name,
		version,
		name: raw.name || raw.tag_name,
		notes: raw.body ?? '',
		url: raw.html_url,
		publishedAt: raw.published_at,
		archiveUrl,
		checksumUrl
	};
}

/** Asks GitHub for the latest release (drafts and pre-releases are never "latest") and keeps the answer. */
export async function checkForUpdate(): Promise<UpdateCheck> {
	let result: UpdateCheck;
	try {
		const raw = await fetchJson<GithubRelease>(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
			headers: { Accept: 'application/vnd.github+json' }
		});
		result = { checkedAt: Date.now(), latest: toRelease(raw), error: null };
	} catch (err) {
		// A failed check keeps what the last one found.
		result = { checkedAt: Date.now(), latest: lastCheck()?.latest ?? null, error: err instanceof Error ? err.message : String(err) };
	}
	writeJson(CHECK_KEY, result);
	return result;
}

/** The newer release the last check found, if there is one. */
export function availableUpdate(): Release | null {
	const latest = lastCheck()?.latest;
	return latest && compareVersions(latest.version, currentVersion()) > 0 ? latest : null;
}

export function lastUpdateRun(): UpdateRun | null {
	return readJson<UpdateRun>(RUN_KEY);
}

const DOWNLOAD_DIR = () => path.join(TMP_DIR, 'update');

/** Why an update cannot start now, or null. */
export function updateBlocker(): string | null {
	if (!installInfo()) return 'This MineShell runs from a source checkout, not an install: update it with git.';
	if (lastUpdateRun()?.outcome === 'running') return 'An update is already under way.';
	const busy = listTasks().find((t) => t.state === 'running');
	if (busy) return `Wait for "${busy.label}" to finish: the update restarts MineShell, which would cut it short.`;
	if (listOperations().length) return 'A server is in the middle of a change: wait for it to finish.';
	return null;
}

export function startUpdate(): string {
	const blocker = updateBlocker();
	if (blocker) throw new UpdateRefused(blocker);
	const release = availableUpdate();
	if (!release) throw new UpdateRefused('There is no newer version to install.');
	const install = installInfo()!;

	return startTask({ label: `Update MineShell to ${release.version}` }, async (task) => {
		const dir = DOWNLOAD_DIR();
		await fs.rm(dir, { recursive: true, force: true });
		await fs.mkdir(dir, { recursive: true });

		task.setProgress(null, 'Downloading');
		const sum = (await fetchText(release.checksumUrl)).trim().split(/\s+/)[0];
		if (!/^[0-9a-f]{64}$/i.test(sum)) throw new Error(`${release.checksumUrl} holds no SHA-256.`);
		const archive = path.join(dir, `mineshell-${release.version}.tar.gz`);
		await downloadFile(release.archiveUrl, archive, {
			hash: { algo: 'sha256', value: sum },
			onProgress: (received, total) => total && task.setProgress((received / total) * 90, 'Downloading')
		});

		// The new release's own installer, from the archive just checked.
		task.setProgress(92, 'Unpacking the installer');
		const inner = `mineshell-${release.version}/scripts/install.sh`;
		const untar = await run(['tar', '-xzf', archive, '-C', dir, inner]);
		if (untar.code !== 0) throw new Error(`Could not unpack the installer: ${untar.stderr.trim()}`);

		const unit = `${install.service}-update-${Date.now()}`;
		writeJson(RUN_KEY, {
			from: currentVersion(),
			to: release.version,
			unit,
			startedAt: Date.now(),
			outcome: 'running',
			finishedAt: null,
			log: []
		} satisfies UpdateRun);

		task.setProgress(95, 'Installing; MineShell restarts in a moment');
		const setenv = {
			MINESHELL_ARCHIVE: archive,
			MINESHELL_HOME: install.home,
			MINESHELL_CONFIG: install.config,
			MINESHELL_SERVICE: install.service,
			MINESHELL_NODE: process.execPath,
			HOME: os.homedir(),
			USER: os.userInfo().username,
			PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'
		};
		const started = await run([
			'systemd-run',
			'--user',
			`--unit=${unit}`,
			'--collect',
			'--quiet',
			`--description=MineShell update to ${release.version}`,
			...Object.entries(setenv).map(([k, v]) => `--setenv=${k}=${v}`),
			'bash',
			path.join(dir, inner)
		]);
		if (started.code !== 0) {
			writeJson(RUN_KEY, { ...lastUpdateRun()!, outcome: 'failed', finishedAt: Date.now(), log: [started.stderr.trim()] });
			throw new Error(`Could not start the installer: ${started.stderr.trim()}`);
		}
	});
}

async function unitLog(unit: string): Promise<string[]> {
	const out = await run(['journalctl', '--user', '-u', unit, '-o', 'cat', '-n', '40', '--no-pager']);
	return out.stdout.split('\n').filter((l) => l.trim());
}

async function unitActive(unit: string): Promise<boolean> {
	const out = await run(['systemctl', '--user', 'is-active', unit]);
	return ['active', 'activating', 'reloading'].includes(out.stdout.trim());
}

/**
 * The last update, settled when its result is known: running this version means
 * it worked; its installer having ended without that means it failed (before
 * restarting MineShell - after a restart, a failed install leaves the old version
 * running, which is the same answer).
 */
export async function updateRunState(): Promise<UpdateRun | null> {
	const last = lastUpdateRun();
	if (!last || last.outcome !== 'running') return last;
	let settled: UpdateRun | null = null;
	if (compareVersions(currentVersion(), last.to) === 0) settled = { ...last, outcome: 'done', finishedAt: Date.now() };
	else if (!(await unitActive(last.unit)))
		settled = { ...last, outcome: 'failed', finishedAt: Date.now(), log: await unitLog(last.unit) };
	if (!settled) return last;
	writeJson(RUN_KEY, settled);
	await fs.rm(DOWNLOAD_DIR(), { recursive: true, force: true });
	return settled;
}

const globals = globalThis as { __mineshellUpdateTimers?: boolean };

/** At boot: settles an update that restarted MineShell, then checks GitHub now and then. */
export function startUpdateChecks(): void {
	void updateRunState().catch((err) => console.warn('[mineshell] reading the last update failed:', err));
	if (globals.__mineshellUpdateTimers) return;
	globals.__mineshellUpdateTimers = true;
	const tick = () => {
		const last = lastCheck();
		if (!autoCheckEnabled() || (last && Date.now() - last.checkedAt < CHECK_EVERY_MS)) return;
		void checkForUpdate().then((r) => r.error && console.warn(`[mineshell] update check failed: ${r.error}`));
	};
	setTimeout(tick, FIRST_CHECK_DELAY_MS).unref();
	setInterval(tick, TICK_MS).unref();
}
