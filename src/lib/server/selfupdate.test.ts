import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';

// Installed or not is what the installer writes into the service's environment.
const install = vi.hoisted(() => ({ on: true }));
vi.mock('$app/env/private', async (importOriginal) => {
	const actual = await importOriginal<Record<string, string | undefined>>();
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
	lastUpdateRun,
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

const API = 'https://api.github.com/repos/Manyullyn17/MineShell-Reloaded/releases/latest';
const DL = 'https://github.com/Manyullyn17/MineShell-Reloaded/releases/download';
const ARCHIVE = Buffer.from('pretend release archive');
const SUM = crypto.createHash('sha256').update(ARCHIVE).digest('hex');

let latest: Record<string, unknown> | number = 404;
let checksum = `${SUM}  mineshell-9.0.0.tar.gz\n`;

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
		[API]: () => (typeof latest === 'number' ? new Response('nope', { status: latest }) : Response.json(latest)),
		[`${DL}/v9.0.0/mineshell-9.0.0.tar.gz`]: () => new Response(new Uint8Array(ARCHIVE)),
		[`${DL}/v9.0.0/mineshell-9.0.0.tar.gz.sha256`]: () => new Response(checksum)
	}
});

afterEach(() => {
	install.on = true;
	latest = 404;
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
