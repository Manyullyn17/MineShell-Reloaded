import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * A server a newer MineShell set up, with a loader or a Minecraft version this one does not
 * know, after going back to this one (ROADMAP, "Legacy versions, more loaders and hybrids").
 * The Mods and World tabs crashed on it ("Unknown mod loader"); its pages load, it says why
 * the loader's actions are refused, and nothing that needs the loader is tried.
 */

const layout = await import('../../src/routes/instances/[id]/+layout.server');
const overview = await import('../../src/routes/instances/[id]/+page.server');
const modsPage = await import('../../src/routes/instances/[id]/mods/+page.server');
const worldPage = await import('../../src/routes/instances/[id]/world/+page.server');
const settingsPage = await import('../../src/routes/instances/[id]/settings/+page.server');
const migrateApi = await import('../../src/routes/api/instances/[id]/migrate/+server');
const { checkForUpdates, runDueUpdateChecks, updateKind } = await import('#lib/server/updatecheck.js');
const { installChunky } = await import('#lib/server/chunky.js');
const { readManifest, MANIFEST } = await import('#lib/server/serverbundle.js');
const { TMP_DIR } = await import('#lib/server/config.js');
const { createInstance, systemdStopped } = await import('../helpers/instances');
const { call, load, post } = await import('../helpers/routes');
const { useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');

// Nothing here may ask a catalog or a loader's metadata: any fetch fails the test.
useRecordedHttp('none');

const UNKNOWN = /legacyfabric, which this version of MineShell does not know/;

const futureLoader = () =>
	createInstance(
		{ modloader: 'legacyfabric', modloaderVersion: '0.15.0', minecraftVersion: '1.8.9', updateCheck: true, modUpdateCheck: true },
		{ 'mods/legacy-mod.jar': 'a mod', 'world/level.dat': 'x', 'server.properties': 'server-port=25565\n' }
	);

describe('a server with a loader this MineShell does not know', () => {
	beforeEach(() => systemdStopped());

	it('loads every tab that crashed, and says why on the overview and Mods', async () => {
		const instance = await futureLoader();
		const params = { id: instance.id };
		const head = await load(layout, { params });
		expect((head.instance as { unknownLoader: string | null }).unknownLoader).toMatch(UNKNOWN);
		// Uploading and switching work on such a server: the notice must not refuse them.
		expect((head.instance as { unknownLoader: string }).unknownLoader).toMatch(/can be uploaded and switched as files; update MineShell to change its loader or Minecraft version or to install mods/);
		await load(overview, { params });
		const mods = await load(modsPage, { params });
		expect(mods.mods).toEqual([expect.objectContaining({ fileName: 'legacy-mod.jar' })]);
		const world = await load(worldPage, { params });
		expect(world.chunkyUnsupported).toMatch(UNKNOWN);
		await load(settingsPage, { params });
	});

	it('refuses what needs the loader with that reason', async () => {
		const instance = await futureLoader();
		const params = { id: instance.id };
		expect(await post(modsPage.actions.install, { params, fields: { source: 'modrinth', projectId: 'P', versionId: 'V' } })).toMatchObject({
			status: 400,
			data: { message: expect.stringMatching(UNKNOWN) }
		});
		expect(await post(settingsPage.actions.migrate, { params, fields: { minecraft: '1.21.1', loader: 'fabric' } })).toMatchObject({
			status: 400,
			data: { message: expect.stringMatching(UNKNOWN) }
		});
		expect(await post(settingsPage.actions.loaderVersion, { params, fields: { modloaderVersion: '0.16.0' } })).toMatchObject({
			status: 400,
			data: { message: expect.stringMatching(UNKNOWN) }
		});
		const plan = await call(migrateApi.GET, { params, url: 'http://localhost/?mc=1.21.1&loader=fabric' });
		expect(plan.status).toBe(400);
		expect((await plan.json()).message).toMatch(UNKNOWN);
		await expect(installChunky(instance)).rejects.toThrow(UNKNOWN);
	});

	it('is left out of the update checks', async () => {
		const instance = await futureLoader();
		expect(updateKind(instance)).toBeNull();
		expect(await checkForUpdates(instance)).toEqual({ ok: true, found: null });
		// Due by every other measure: a lookup would fail the test (no network).
		await runDueUpdateChecks(Date.now() + 365 * 24 * 3600_000);
	});

	it('refuses to import an export of one', async () => {
		const file = path.join(TMP_DIR, `future-${crypto.randomUUID()}.zip`);
		await fs.writeFile(
			file,
			await zipBuffer({ [MANIFEST]: JSON.stringify({ format: 1, mineshell: '2.0.0', server: { minecraftVersion: '1.8.9', modloader: 'legacyfabric' } }) })
		);
		await expect(readManifest(file)).rejects.toThrow(/runs legacyfabric, which this MineShell does not know: it is from a newer one \(2\.0\.0\)/);
	});
});

describe('a server on a Minecraft version this MineShell does not list', () => {
	beforeEach(() => systemdStopped());

	it('loads its tabs', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: 'b1.7.3' }, { 'world/level.dat': 'x' });
		const params = { id: instance.id };
		const head = await load(layout, { params });
		expect((head.instance as { unknownLoader: string | null }).unknownLoader).toBeNull();
		await load(overview, { params });
		await load(modsPage, { params });
		await load(worldPage, { params });
		await load(settingsPage, { params });
	});
});
