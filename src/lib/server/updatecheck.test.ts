import { describe, expect, it } from 'vitest';
import {
	checkDue,
	checkForUpdates,
	checkModsForUpdates,
	modsChecked,
	currentNotice,
	forgeChannel,
	loaderChannel,
	pickLoaderUpdate,
	pickPackUpdate,
	skipNotice,
	updateKind,
	type FoundUpdate
} from './updatecheck';
import { createInstance, reload } from '../../../tests/helpers/instances';
import { currentModNotice, skipModNotice } from './modnotice';
import { channelLabel, channelNote, channelsFor } from '#lib/shared/updatecheck.js';

const v = (id: string, channel: string, date: string | null) => ({ id, name: id, versionNumber: id, channel, datePublished: date });

describe('pickPackUpdate', () => {
	const list = [
		v('3-beta', 'beta', '2026-10-03T00:00:00Z'),
		v('2', 'release', '2026-10-02T00:00:00Z'),
		v('1', 'release', '2026-10-01T00:00:00Z')
	];

	it('offers the newest release after the installed one, betas only when asked', () => {
		expect(pickPackUpdate(list, '1', 'release')?.versionId).toBe('2');
		expect(pickPackUpdate(list, '1', 'beta')).toEqual({ versionId: '3-beta', label: '3-beta', channel: 'beta' });
		expect(pickPackUpdate(list, '2', 'release')).toBeNull();
	});

	it('goes by date, not by the list order (a priority sort puts releases first)', () => {
		const sorted = [v('1', 'release', '2026-10-01T00:00:00Z'), v('2-beta', 'beta', '2026-10-02T00:00:00Z')];
		expect(pickPackUpdate(sorted, '1', 'beta')?.versionId).toBe('2-beta');
	});

	it("falls back to the provider's order when dates are missing, and needs the installed version listed", () => {
		const undated = [v('b', 'release', null), v('a', 'release', null)];
		expect(pickPackUpdate(undated, 'a', 'release')?.versionId).toBe('b');
		expect(pickPackUpdate(undated, 'gone', 'release')).toBeNull();
	});
});

describe('loader builds', () => {
	it.each([
		['0.16.9', 'release'],
		['47.3.0', 'release'],
		['0.26.4-beta.5', 'beta'],
		['21.1.0-rc.1', 'beta'],
		['0.5.17-alpha', 'alpha']
	])('%s is a %s', (version, channel) => {
		expect(loaderChannel(version)).toBe(channel);
	});

	it('offers the newest build above the installed one on an allowed channel', () => {
		const list = ['0.17.0-beta.1', '0.16.10', '0.16.9'];
		expect(pickLoaderUpdate('fabric', list, '0.16.9', 'release')).toBe('0.16.10');
		expect(pickLoaderUpdate('fabric', list, '0.16.9', 'beta')).toBe('0.17.0-beta.1');
		expect(pickLoaderUpdate('fabric', list, '0.17.0-beta.1', 'release')).toBeNull();
		expect(pickLoaderUpdate('fabric', list, 'unlisted', 'release')).toBeNull();
	});

	// Forge 1.12.2 recommends 14.23.5.2859; the update check offered 2864 as a plain release.
	it("treats Forge's recommended build as the release and newer ones as betas", () => {
		const list = ['14.23.5.2864', '14.23.5.2860', '14.23.5.2859', '14.23.5.2858'];
		const channelOf = forgeChannel('14.23.5.2859');
		expect(pickLoaderUpdate('forge', list, '14.23.5.2858', 'release', channelOf)).toBe('14.23.5.2859');
		expect(pickLoaderUpdate('forge', list, '14.23.5.2859', 'release', channelOf)).toBeNull();
		expect(pickLoaderUpdate('forge', list, '14.23.5.2859', 'beta', channelOf)).toBe('14.23.5.2864');
		// No recommended build for the version: every build is a release.
		expect(pickLoaderUpdate('forge', list, '14.23.5.2859', 'release', forgeChannel(null))).toBe('14.23.5.2864');
	});

	// Forge's metadata lists 1.12.2 as 2864-2861, then 14.23.0.2486 onwards: going by place offered 2486 over 2859.
	it('goes by version number, not by where a build sits in the list', () => {
		const list = ['14.23.5.2864', '14.23.5.2861', '14.23.0.2486', '14.23.0.2487', '14.23.5.2859'];
		expect(pickLoaderUpdate('forge', list, '14.23.5.2859', 'release', forgeChannel('14.23.5.2859'))).toBeNull();
		expect(pickLoaderUpdate('forge', list, '14.23.5.2859', 'beta', forgeChannel('14.23.5.2859'))).toBe('14.23.5.2864');
		expect(pickLoaderUpdate('quilt', ['0.20.0-beta.9', '0.24.0', '0.30.1', '0.26.4'], '0.26.4', 'release')).toBe('0.30.1');
	});

	it('says it in Forge\'s terms on a Forge server', () => {
		expect(channelsFor('forge')).toEqual(['release', 'beta']);
		expect(channelLabel('release', 'forge')).toBe('Recommended');
		expect(channelLabel('beta', 'fabric')).toBe('Betas too');
		expect(channelNote('beta', 'forge')).toBe('not yet recommended');
		expect(channelNote('beta', null)).toBe('beta');
		expect(channelNote('release', 'forge')).toBeNull();
	});

	it("keeps Cleanroom on its own line: 0.6 swapped Mixin for CleanMix, which breaks mods", () => {
		const list = ['0.6.10-alpha', '0.5.18-alpha', '0.5.17-alpha'];
		expect(pickLoaderUpdate('cleanroom', list, '0.5.17-alpha', 'release')).toBe('0.5.18-alpha');
		expect(pickLoaderUpdate('cleanroom', list, '0.5.18-alpha', 'alpha')).toBeNull();
	});
});

describe('update notices', () => {
	const found = (versionId: string, fromVersion = '1.0'): FoundUpdate => ({ kind: 'pack', fromVersion, versionId, label: versionId, channel: 'release' });
	const packServer = () =>
		createInstance({ modloader: 'forge', minecraftVersion: '1.20.1', packSource: 'modrinth', packProjectId: 'p', packVersionId: '1.0' });

	it('checks pack servers for packs and only servers without a pack for loaders', () => {
		expect(updateKind({ packSource: 'modrinth', packProjectId: 'p', modloader: 'forge' })).toBe('pack');
		expect(updateKind({ packSource: 'manual', packProjectId: null, modloader: 'forge' })).toBeNull();
		expect(updateKind({ packSource: null, packProjectId: null, modloader: 'fabric' })).toBe('loader');
		expect(updateKind({ packSource: null, packProjectId: null, modloader: 'vanilla' })).toBeNull();
	});

	it('shows what it found until skipped, and a newer version again', async () => {
		const instance = await packServer();
		await checkForUpdates(instance, async () => found('1.1'));
		expect(currentNotice(reload(instance.id))?.versionId).toBe('1.1');

		expect(skipNotice(instance.id, '1.1')).toBe(true);
		await checkForUpdates(reload(instance.id), async () => found('1.1'));
		expect(currentNotice(reload(instance.id))).toBeNull();

		await checkForUpdates(reload(instance.id), async () => found('1.2'));
		expect(currentNotice(reload(instance.id))?.versionId).toBe('1.2');

		await checkForUpdates(reload(instance.id), async () => null);
		expect(currentNotice(reload(instance.id))).toBeNull();
	});

	it('hides a notice once the server moved on from the version it was found from', async () => {
		const instance = await packServer();
		await checkForUpdates(instance, async () => found('1.1'));
		const { db } = await import('./db');
		const { serverInstances } = await import('./db/schema');
		const { eq } = await import('drizzle-orm');
		db.update(serverInstances).set({ packVersionId: '1.1' }).where(eq(serverInstances.id, instance.id)).run();
		expect(currentNotice(reload(instance.id))).toBeNull();
	});

	it('is due by its interval, off when turned off, and retried within the hour after a failed lookup', async () => {
		const instance = await packServer();
		expect(checkDue(instance)).toBe(true);
		await checkForUpdates(instance, async () => null);
		const checked = reload(instance.id);
		expect(checkDue(checked)).toBe(false);
		expect(checkDue(checked, checked.updateCheckedAt! + 24 * 3600_000)).toBe(true);
		expect(checkDue({ ...checked, updateCheck: false }, Date.now() + 365 * 24 * 3600_000)).toBe(false);

		const result = await checkForUpdates(checked, async () => {
			throw new Error('offline');
		});
		expect(result).toEqual({ ok: false, error: 'offline' });
		const failed = reload(instance.id);
		expect(checkDue(failed, Date.now() + 30 * 60_000)).toBe(false);
		expect(checkDue(failed, Date.now() + 61 * 60_000)).toBe(true);
	});
});

describe('mod update notices', () => {
	const update = (fileName: string, to: string, enabled = true) => ({ fileName, name: fileName.replace(/-.*/, ''), currentVersion: '1', targetVersion: to, enabled });
	const found = (...updates: ReturnType<typeof update>[]) => async () => ({ updates });

	it('checks mods only on servers without a pack, when asked', () => {
		expect(modsChecked({ packSource: null, packProjectId: null, modloader: 'fabric', modUpdateCheck: true })).toBe(true);
		expect(modsChecked({ packSource: null, packProjectId: null, modloader: 'fabric', modUpdateCheck: false })).toBe(false);
		expect(modsChecked({ packSource: 'modrinth', packProjectId: 'p', modloader: 'fabric', modUpdateCheck: true })).toBe(false);
		expect(modsChecked({ packSource: null, packProjectId: null, modloader: 'vanilla', modUpdateCheck: true })).toBe(false);
	});

	it('shows enabled mods’ updates until skipped, and a different set again', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		expect(await checkModsForUpdates(instance, found(update('sodium-1.jar', '2'), update('off-1.jar', '2', false)))).toEqual({ ok: true, count: 1 });
		const notice = currentModNotice(instance.id)!;
		expect(notice.updates).toEqual([{ fileName: 'sodium-1.jar', name: 'sodium', from: '1', to: '2' }]);

		expect(skipModNotice(instance.id, notice.fingerprint)).toBe(true);
		await checkModsForUpdates(instance, found(update('sodium-1.jar', '2')));
		expect(currentModNotice(instance.id)).toBeNull();

		await checkModsForUpdates(instance, found(update('sodium-1.jar', '3')));
		expect(currentModNotice(instance.id)?.updates[0].to).toBe('3');

		await checkModsForUpdates(instance, found());
		expect(currentModNotice(instance.id)).toBeNull();
		expect(await checkModsForUpdates(instance, async () => Promise.reject(new Error('offline')))).toEqual({ ok: false, error: 'offline' });
	});
});
