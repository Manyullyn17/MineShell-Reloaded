import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInstance } from '$lib/server/db/schema';

vi.mock('$lib/server/cleanroom', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/cleanroom')>();
	return {
		...actual,
		applyCleanroomModFixes: vi.fn(async (_instance: ServerInstance) => ({ disabled: [], added: [], failures: [], advise: [] }))
	};
});

const { createFromPack } = await import('$lib/server/instances');
const { LOADERS } = await import('$lib/server/modloaders');
const { packFromFileList } = await import('$lib/server/packs');
const { listInstanceMods } = await import('$lib/server/mods');
const { readProperties } = await import('$lib/server/properties');
const cleanroom = await import('$lib/server/cleanroom');
const { addJava, clearJava, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');

/** Files the fake pack host serves, by URL. */
const served: Record<string, () => Response> = {
	// Mod identification by hash: nothing recognised, so pack jars are tracked as manual.
	'https://api.modrinth.com/v2/version_files': () => Response.json({})
};
useRecordedHttp('none', { extra: served });

function serve(url: string, body: string | Buffer) {
	served[url] = () => new Response(typeof body === 'string' ? body : new Uint8Array(body));
}

/** A CurseForge-style file-list pack: two mods plus overrides.zip, at URLs of its own. */
let packs = 0;
function pack(opts: { loader?: 'forge' | 'fabric'; minecraft?: string; missing?: boolean } = {}) {
	const base = `https://files.test/${++packs}`;
	serve(`${base}/a.jar`, 'mod a');
	if (!opts.missing) serve(`${base}/b.jar`, 'mod b');
	serve(
		`${base}/overrides.zip`,
		zipBuffer({
			'overrides/config/pack.cfg': 'from the pack',
			'overrides/mods/bundled.jar': 'bundled mod',
			'overrides/server.properties': 'motd=Pack MOTD\nserver-port=1\nenable-rcon=false\n'
		})
	);
	return packFromFileList({
		name: 'Test Pack',
		version: '1.0',
		minecraftVersion: opts.minecraft ?? '1.20.1',
		modloader: opts.loader ?? 'fabric',
		modloaderVersion: null,
		files: [
			{ path: 'mods/', name: 'a.jar', url: `${base}/a.jar` },
			{ path: 'mods/', name: 'b.jar', url: `${base}/b.jar` },
			{ path: './', name: 'overrides.zip', url: `${base}/overrides.zip` }
		]
	});
}

function fakeInstall(loader: 'fabric' | 'forge' | 'cleanroom') {
	return vi.spyOn(LOADERS[loader], 'install').mockImplementation(async (ctx) => {
		await fs.writeFile(path.join(ctx.dir, 'server.jar'), loader);
		return { launchArgs: `-jar ${loader}.jar nogui`, loaderVersion: ctx.loaderVersion ?? `${loader}-latest` };
	});
}

describe('installing a pack', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(8);
		addJava(17);
		addJava(25);
	});
	afterEach(() => vi.restoreAllMocks());

	it('downloads mods and unpacks overrides.zip, keeping MineShell’s ports', async () => {
		fakeInstall('fabric');
		const { instance, taskId } = await createFromPack('My Pack', pack(), { source: 'curseforge', projectId: '1', versionId: 'v1' });
		expect((await waitForTask(taskId)).state).toBe('done');

		const files = await tree(instance.path);
		expect(files).toMatchObject({
			'mods/a.jar': 'mod a',
			'mods/b.jar': 'mod b',
			'mods/bundled.jar': 'bundled mod',
			'config/pack.cfg': 'from the pack',
			'server.jar': 'fabric'
		});
		expect(Object.keys(files)).not.toContain('mods/overrides.zip');

		// The pack's own server.properties wins, except for what MineShell manages.
		const props = (await readProperties(instance.path)).values;
		expect(props.motd).toBe('Pack MOTD');
		expect(props['server-port']).toBe(String(instance.serverPort));
		expect(props['enable-rcon']).toBe('true');

		const row = reload(instance.id);
		expect(row).toMatchObject({ status: 'ready', statusMessage: null, launchArgs: '-jar fabric.jar nogui', packVersionId: 'v1' });
		const mods = await listInstanceMods(row);
		expect(mods.map((m) => m.fileName).sort()).toEqual(['a.jar', 'b.jar', 'bundled.jar']);
		expect(mods.every((m) => m.fromPack && !m.untracked)).toBe(true);
	});

	it('reports mods that could not be downloaded', async () => {
		fakeInstall('fabric');
		const { taskId, instance } = await createFromPack('Broken', pack({ missing: true }), { source: 'curseforge' });
		await waitForTask(taskId);
		expect(reload(instance.id).statusMessage).toMatch(/1 mod could not be downloaded/);
	});

	it('installs a Forge 1.12.2 pack on Cleanroom when asked', async () => {
		const forge = fakeInstall('forge');
		const cr = fakeInstall('cleanroom');
		const { instance, taskId } = await createFromPack(
			'On Cleanroom',
			pack({ loader: 'forge', minecraft: '1.12.2' }),
			{ source: 'curseforge' },
			{ modloader: 'cleanroom', modloaderVersion: '0.5.17-alpha' }
		);
		expect((await waitForTask(taskId)).state).toBe('done');
		expect(forge).not.toHaveBeenCalled();
		expect(cr.mock.calls[0][0]).toMatchObject({ loaderVersion: '0.5.17-alpha', javaPath: '/fake/jvm/java-25/bin/java' });
		expect(cleanroom.applyCleanroomModFixes).toHaveBeenCalled();
		expect(reload(instance.id)).toMatchObject({ modloader: 'cleanroom', modloaderVersion: '0.5.17-alpha' });
	});

	it('ignores a Cleanroom request for anything but Forge 1.12.2, and says so', async () => {
		const fabric = fakeInstall('fabric');
		const { instance, taskId } = await createFromPack('Fabric', pack(), { source: 'curseforge' }, { modloader: 'cleanroom' });
		await waitForTask(taskId);
		expect(fabric).toHaveBeenCalled();
		const row = reload(instance.id);
		expect(row.modloader).toBe('fabric');
		expect(row.statusMessage).toMatch(/Cleanroom was requested/);
	});
});
