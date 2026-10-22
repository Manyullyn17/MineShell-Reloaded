import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';

// Installed or not is what the installer writes into the service's environment.
const install = vi.hoisted(() => ({ on: true }));
vi.mock('$app/env/private', async (importOriginal) => {
	const { workerEnv } = await import('../../../tests/helpers/env');
	const actual = workerEnv(await importOriginal<Record<string, string | undefined>>());
	return {
		...actual,
		get MINESHELL_INSTALL_HOME() {
			return install.on ? '/home/u/mineshell' : undefined;
		},
		get MINESHELL_INSTALL_CONFIG() {
			return install.on ? '/home/u/.config/mineshell/mineshell.env' : undefined;
		},
		get MINESHELL_INSTALL_SERVICE() {
			return install.on ? 'mineshell' : undefined;
		}
	};
});

const {
	availableUpdate,
	checkForUpdate,
	compareVersions,
	currentVersion,
	DB_BACKUP_DIR,
	HISTORY_SINCE,
	lastUpdateRun,
	leftBehind,
	planDowngrade,
	releaseHistory,
	startDowngrade,
	startUpdate,
	updateBlocker,
	updateRunState,
	UpdateRefused
} = await import('./selfupdate');
const { useRecordedHttp } = await import('../../../tests/helpers/http');
const { createInstance, waitForTask } = await import('../../../tests/helpers/instances');
const { startTask } = await import('./tasks');
const { beginOperation, endOperation } = await import('./operations');
const { db } = await import('./db');
const { settings } = await import('./db/schema');
const { like } = await import('drizzle-orm');

const API = 'https://api.github.com/repos/Manyullyn17/MineShell-Reloaded/releases?per_page=100&page=1';
const CONTENTS = (tag: string) => `https://api.github.com/repos/Manyullyn17/MineShell-Reloaded/contents/migrations?ref=${tag}`;
const DL = 'https://github.com/Manyullyn17/MineShell-Reloaded/releases/download';
const ARCHIVE = Buffer.from('pretend release archive');
const SUM = crypto.createHash('sha256').update(ARCHIVE).digest('hex');

let latest: Record<string, unknown> | number = 404;
let older: Record<string, unknown>[] = [];
let checksum = `${SUM}  mineshell-9.0.0.tar.gz\n`;
// The migrations each older release has, as GitHub lists them; absent = GitHub fails.
const ALL_MIGRATIONS = fs.readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
let releaseMigrations: Record<string, string[]> = {};

function release(version: string, assets = true) {
	const file = `mineshell-${version}.tar.gz`;
	return {
		tag_name: `v${version}`,
		name: `MineShell v${version}`,
		body: '## What changed\n- things',
		html_url: `https://github.com/Manyullyn17/MineShell-Reloaded/releases/tag/v${version}`,
		published_at: '2026-10-20T10:00:00Z',
		draft: false,
		prerelease: false,
		assets: assets
			? [
					{ name: file, browser_download_url: `${DL}/v${version}/${file}` },
					{ name: `${file}.sha256`, browser_download_url: `${DL}/v${version}/${file}.sha256` }
				]
			: []
	};
}

useRecordedHttp('selfupdate', {
	extra: {
		[API]: () => (typeof latest === 'number' ? new Response('nope', { status: latest }) : Response.json([...older, latest])),
		[`${DL}/v9.0.0/mineshell-9.0.0.tar.gz`]: () => new Response(new Uint8Array(ARCHIVE)),
		[`${DL}/v9.0.0/mineshell-9.0.0.tar.gz.sha256`]: () => new Response(checksum),
		[`${DL}/v0.20.0/mineshell-0.20.0.tar.gz`]: () => new Response(new Uint8Array(ARCHIVE)),
		[`${DL}/v0.20.0/mineshell-0.20.0.tar.gz.sha256`]: () => new Response(`${SUM}  mineshell-0.20.0.tar.gz\n`),
		...Object.fromEntries(
			['v0.1.0', 'v0.12.0', 'v0.20.0', 'v0.23.0'].map((tag) => [
				CONTENTS(tag),
				() =>
					releaseMigrations[tag]
						? Response.json(releaseMigrations[tag].map((name) => ({ name, type: 'file' })))
						: new Response('rate limited', { status: 403 })
			])
		)
	}
});

afterEach(() => {
	install.on = true;
	latest = 404;
	older = [];
	releaseMigrations = {};
	fs.rmSync(DB_BACKUP_DIR(), { recursive: true, force: true });
	checksum = `${SUM}  mineshell-9.0.0.tar.gz\n`;
	db.delete(settings).where(like(settings.key, 'update.%')).run();
});

describe('versions', () => {
	it('compares numerically, ignoring a leading v', () => {
		expect(compareVersions('0.10.0', '0.9.3')).toBe(1);
		expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
		expect(compareVersions('1.2', '1.2.1')).toBe(-1);
	});

	it("knows its own version from package.json", () => {
		expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe('checking for updates', () => {
	it('offers a newer release, with its notes and files', async () => {
		latest = release('9.0.0');
		const result = await checkForUpdate();
		expect(result.error).toBeNull();
		expect(availableUpdate()).toMatchObject({ version: '9.0.0', notes: '## What changed\n- things', archiveUrl: `${DL}/v9.0.0/mineshell-9.0.0.tar.gz` });
	});

	it('offers nothing when the latest is the running version', async () => {
		latest = release(currentVersion());
		await checkForUpdate();
		expect(availableUpdate()).toBeNull();
	});

	it('keeps what the last check found when GitHub does not answer', async () => {
		latest = release('9.0.0');
		await checkForUpdate();
		latest = 503;
		const result = await checkForUpdate();
		expect(result.error).toContain('503');
		expect(availableUpdate()?.version).toBe('9.0.0');
	});

	it('lists every published release newest first, without drafts, pre-releases or ones that cannot be installed', async () => {
		latest = release('9.0.0');
		older = [
			release('0.20.0'),
			{ ...release('8.0.0'), draft: true },
			{ ...release('8.5.0'), prerelease: true },
			release('0.1.0', false),
			release('0.23.0')
		];
		await checkForUpdate();
		expect(releaseHistory().map((r) => r.version)).toEqual(['9.0.0', '0.23.0', '0.20.0']);
		expect(availableUpdate()?.version).toBe('9.0.0');
	});

	it('refuses a release without its archive and checksum', async () => {
		latest = release('9.0.0', false);
		const result = await checkForUpdate();
		expect(result.error).toContain('has no mineshell-9.0.0.tar.gz');
		expect(availableUpdate()).toBeNull();
	});
});

describe('updating', () => {
	it('verifies the download, then runs its installer as a unit of its own', async () => {
		latest = release('9.0.0');
		await checkForUpdate();
		fakeProcesses(() => ({}));
		const task = await waitForTask(startUpdate());
		expect(task.error).toBeNull();

		const tar = spawnCalls.find((c) => c.cmd === 'tar')!;
		expect(tar.args).toContain('mineshell-9.0.0/scripts/install.sh');
		const unit = spawnCalls.find((c) => c.cmd === 'systemd-run')!;
		expect(unit.args).toContain('--user');
		expect(unit.args).toContain('--setenv=MINESHELL_HOME=/home/u/mineshell');
		expect(unit.args).toContain('--setenv=MINESHELL_CONFIG=/home/u/.config/mineshell/mineshell.env');
		expect(unit.args).toContain('--setenv=MINESHELL_SERVICE=mineshell');
		expect(unit.args.some((a) => /^--setenv=MINESHELL_ARCHIVE=.*mineshell-9\.0\.0\.tar\.gz$/.test(a))).toBe(true);
		expect(unit.args.at(-1)).toMatch(/mineshell-9\.0\.0\/scripts\/install\.sh$/);
		expect(lastUpdateRun()).toMatchObject({ from: currentVersion(), to: '9.0.0', outcome: 'running' });
	});

	it('runs nothing when the archive does not match its checksum', async () => {
		latest = release('9.0.0');
		checksum = `${'0'.repeat(64)}  mineshell-9.0.0.tar.gz\n`;
		await checkForUpdate();
		fakeProcesses(() => ({}));
		const task = await waitForTask(startUpdate());
		expect(task.error).toContain('Checksum mismatch');
		expect(spawnCalls).toEqual([]);
		expect(lastUpdateRun()).toBeNull();
	});

	it('refuses from a source checkout', async () => {
		install.on = false;
		latest = release('9.0.0');
		await checkForUpdate();
		expect(updateBlocker()).toContain('source checkout');
		expect(() => startUpdate()).toThrow(UpdateRefused);
	});

	it('refuses while a task or a journalled operation would be cut short by the restart', async () => {
		latest = release('9.0.0');
		await checkForUpdate();
		let release_: () => void = () => undefined;
		const id = startTask({ label: 'Install pack' }, () => new Promise<void>((r) => (release_ = r)));
		expect(updateBlocker()).toContain('Install pack');
		release_();
		await waitForTask(id);

		const server = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		beginOperation(server.id, { kind: 'bisect' } as never);
		expect(updateBlocker()).toContain('middle of a change');
		endOperation(server.id);
		expect(updateBlocker()).toBeNull();
	});

	it('refuses when there is nothing newer', () => {
		expect(() => startUpdate()).toThrow('no newer version');
	});
});

describe('the result, after the restart', () => {
	const running = (to: string) =>
		db
			.insert(settings)
			.values({
				key: 'update.run',
				value: JSON.stringify({ from: '0.0.1', to, unit: 'mineshell-update-1', startedAt: 1, outcome: 'running', finishedAt: null, log: [] })
			})
			.run();

	it('is done when this is the version it installed', async () => {
		running(currentVersion());
		expect((await updateRunState())?.outcome).toBe('done');
	});

	it("failed when its installer ended without it, with the installer's log", async () => {
		running('9.0.0');
		fakeProcesses((cmd) =>
			cmd === 'systemctl' ? { stdout: 'inactive\n', code: 3 } : { stdout: 'MineShell install: the download does not match its checksum.\n' }
		);
		const run = await updateRunState();
		expect(run).toMatchObject({ outcome: 'failed', log: ['MineShell install: the download does not match its checksum.'] });
		expect(lastUpdateRun()?.outcome).toBe('failed');
	});

	it('is still running while its installer is', async () => {
		running('9.0.0');
		fakeProcesses(() => ({ stdout: 'active\n' }));
		expect((await updateRunState())?.outcome).toBe('running');
	});
});

describe('going back to an older release', () => {
	// The release list with 0.20.0 (migrations up to 0022) and 0.12.0 (before the accounts migration).
	async function listed() {
		latest = release(currentVersion());
		older = [release('0.23.0'), release('0.20.0'), release('0.12.0'), release('0.1.0')];
		await checkForUpdate();
	}
	const upTo = (last: string) => ALL_MIGRATIONS.filter((f) => f.slice(0, 4) <= last);

	it('allows it when every migration the release lacks only adds, and says what it lacks', async () => {
		await listed();
		releaseMigrations['v0.20.0'] = upTo('0022');
		const plan = await planDowngrade('0.20.0');
		expect(plan.refusal).toBeNull();
		expect(plan.missing.length).toBeGreaterThan(0);
		expect(plan.missing.every((m) => m.safe)).toBe(true);
		expect(plan.missing[0].name).toMatch(/^0023/);
		expect(plan.beforeHistory).toBe(compareVersions('0.20.0', HISTORY_SINCE) < 0);
	});

	it('refuses one that lacks a migration marked unsafe (the accounts one: an older MineShell finds no password)', async () => {
		await listed();
		releaseMigrations['v0.12.0'] = upTo('0018');
		const plan = await planDowngrade('0.12.0');
		expect(plan.refusal).toContain('0019_users');
		expect(plan.missing.find((m) => m.name === '0019_users.sql')?.safe).toBe(false);
		await expect(startDowngrade('0.12.0')).rejects.toThrow(UpdateRefused);
	});

	it('warns what an older release does differently with data this one leaves', () => {
		// Going back from a release with shared snapshots to one without: retention would count them in full.
		const warnings = leftBehind('0.31.0', '0.32.0');
		expect(warnings).toEqual([expect.stringMatching(/counts each at its full size/), expect.stringMatching(/no backup folders/)]);
		expect(leftBehind('0.32.0', '0.33.0')).toEqual([]);
		// Not from a release that never had them either.
		expect(leftBehind('0.30.0', '0.31.0')).toEqual([]);
	});

	it('refuses when GitHub does not say which migrations the release has', async () => {
		await listed();
		const plan = await planDowngrade('0.20.0');
		expect(plan.refusal).toContain('Could not read');
	});

	it('refuses a version that is not older, or not in the list', async () => {
		await listed();
		await expect(planDowngrade(currentVersion())).rejects.toThrow('not older');
		await expect(planDowngrade('0.5.5')).rejects.toThrow('not in the release list');
	});

	it('backs up the database, then runs the older release\'s installer', async () => {
		await listed();
		releaseMigrations['v0.20.0'] = upTo('0022');
		fakeProcesses(() => ({}));
		const task = await waitForTask(await startDowngrade('0.20.0'));
		expect(task.error).toBeNull();
		expect(spawnCalls.find((c) => c.cmd === 'systemd-run')!.args.at(-1)).toMatch(/mineshell-0\.20\.0\/scripts\/install\.sh$/);
		expect(lastUpdateRun()).toMatchObject({ from: currentVersion(), to: '0.20.0', outcome: 'running' });
		const backups = fs.readdirSync(DB_BACKUP_DIR()).filter((f) => f.endsWith(`-${currentVersion()}-to-0.20.0.db`));
		expect(backups).toHaveLength(1);
	});

	it('keeps only the newest five database backups', async () => {
		await listed();
		releaseMigrations['v0.20.0'] = upTo('0022');
		fs.mkdirSync(DB_BACKUP_DIR(), { recursive: true });
		for (let i = 0; i < 6; i++) fs.writeFileSync(`${DB_BACKUP_DIR()}/mineshell-2000-01-0${i + 1}-old.db`, '');
		fakeProcesses(() => ({}));
		await waitForTask(await startDowngrade('0.20.0'));
		const left = fs.readdirSync(DB_BACKUP_DIR()).sort();
		expect(left).toHaveLength(5);
		expect(left.filter((f) => f.startsWith('mineshell-2000'))).toHaveLength(4);
	});
});
