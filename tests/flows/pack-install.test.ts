import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInstance } from '#lib/server/db/schema.js';

vi.mock('#lib/server/cleanroom.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/cleanroom.js')>();
	return {
		...actual,
		applyCleanroomModFixes: vi.fn(async (_instance: ServerInstance) => ({ disabled: [], added: [], failures: [], advise: [] }))
	};
});

const { createFromPack } = await import('#lib/server/instances.js');
const { LOADERS } = await import('#lib/server/modloaders.js');
const { packFromFileList, parsePack } = await import('#lib/server/packs/index.js');
const { listInstanceMods, syncMods } = await import('#lib/server/mods/index.js');
const { readProperties } = await import('#lib/server/properties.js');
const cleanroom = await import('#lib/server/cleanroom.js');
const { addJava, clearJava, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');
const { spawnCalls } = await import('../helpers/process');

/** Files the fake pack host serves, by URL. */
const served: Record<string, () => Response> = {
	// Mod identification by hash: nothing recognised, so pack jars are tracked as manual.
	'https://api.modrinth.com/v2/version_files': () => Response.json({})
};
useRecordedHttp('none', { extra: served });

function serve(url: string, body: string | Buffer) {
	served[url] = () => new Response(typeof body === 'string' ? body : new Uint8Array(body));
}

type MirrorFile = { id: number; name: string; version?: string };

function mirrorFile(f: MirrorFile) {
	return { ...f, url: `https://files.test/cf/${f.name}`, targets: [] };
}

/** The modpacks.ch record of a CurseForge project: name, icon, page, newest files. */
function mirrorProject(id: number, name: string, newest: MirrorFile[] = []) {
	served[`https://api.modpacks.ch/public/mod/${id}`] = () =>
		Response.json({
			id,
			name,
			synopsis: `${name}, in short`,
			art: [{ type: 'square', url: `https://img.test/${id}.png` }],
			links: [{ type: 'curseforge', link: `https://www.curseforge.com/minecraft/mc-mods/${id}` }],
			versions: newest.map(mirrorFile)
		});
}

/** A CurseForge-style file-list pack: two mods plus overrides.zip, at URLs of its own. */
let packs = 0;
function pack(
	opts: {
		loader?: 'forge' | 'fabric';
		minecraft?: string;
		missing?: boolean;
		/** CurseForge project and file ids for a.jar and b.jar, as modpacks.ch lists them. */
		curseforge?: [string, string][];
	} = {}
) {
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
			{ path: 'mods/', name: 'a.jar', url: `${base}/a.jar`, curseforge: ids(opts.curseforge?.[0]) },
			{ path: 'mods/', name: 'b.jar', url: `${base}/b.jar`, curseforge: ids(opts.curseforge?.[1]) },
			{ path: './', name: 'overrides.zip', url: `${base}/overrides.zip` }
		]
	});
}

function ids(pair?: [string, string]) {
	return pair ? { projectId: pair[0], fileId: pair[1] } : undefined;
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

	it('tracks a CurseForge pack’s mods as the CurseForge mods they are', async () => {
		// Previously identified by hash against Modrinth only: a mod also on
		// Modrinth was tracked as Modrinth, the rest as manual.
		fakeInstall('fabric');
		mirrorProject(100, 'Mod A', [{ id: 1001, name: 'a.jar', version: '1.0 for Fabric 1.20.1' }]);
		served['https://api.modpacks.ch/public/mod/200'] = () => new Response('down', { status: 500 });
		const { instance, taskId } = await createFromPack(
			'From CurseForge',
			pack({ curseforge: [['100', '1001'], ['200', '2001']] }),
			{ source: 'curseforge', projectId: '1', versionId: 'v1' }
		);
		expect((await waitForTask(taskId)).state).toBe('done');

		const mods = Object.fromEntries((await listInstanceMods(reload(instance.id))).map((m) => [m.fileName, m]));
		expect(mods['a.jar']).toMatchObject({
			source: 'curseforge',
			slug: '100',
			name: 'Mod A',
			version: '1.0 for Fabric 1.20.1',
			versionId: '1001',
			projectUrl: 'https://www.curseforge.com/minecraft/mc-mods/100',
			fromPack: true
		});
		// The mirror being down only costs the name.
		expect(mods['b.jar']).toMatchObject({ source: 'curseforge', slug: '200', name: 'b', versionId: '2001' });
		// Bundled in the overrides: nothing says where it came from.
		expect(mods['bundled.jar']).toMatchObject({ source: 'manual' });
	});

	it('re-tracks pack mods an earlier install got wrong', async () => {
		fakeInstall('fabric');
		const { instance, taskId } = await createFromPack('Older Install', pack(), { source: 'curseforge' });
		await waitForTask(taskId);
		const before = await listInstanceMods(reload(instance.id));
		expect(before.find((m) => m.fileName === 'a.jar')).toMatchObject({ source: 'manual' });

		// What Sync does for a CurseForge pack: the pack's file list says which project each jar is.
		mirrorProject(300, 'Mod A Again');
		const result = await syncMods(reload(instance.id), {
			curseforge: new Map([['a.jar', { projectId: '300', fileId: '3001' }]])
		});
		expect(result.curseforge).toBe(1);
		const after = Object.fromEntries((await listInstanceMods(reload(instance.id))).map((m) => [m.fileName, m]));
		expect(after['a.jar']).toMatchObject({ source: 'curseforge', slug: '300', name: 'Mod A Again', fromPack: true });
		expect(after['b.jar']).toMatchObject({ source: 'manual' });
	});

	it('installs an uploaded CurseForge zip whose mods are older than the newest files', async () => {
		// Without an API key, the mirror's project record only has the newest
		// 50 files; older ones are found by paging the pack's Minecraft version.
		fakeInstall('fabric');
		mirrorProject(400, 'Old Mod', [{ id: 4999, name: 'old-mod-9.jar' }]);
		served['https://api.modpacks.ch/public/mod/400/versions/1.20.1'] = () =>
			Response.json({ versions: [mirrorFile({ id: 4500, name: 'old-mod-5.jar' })], page: 1, pages: 2 });
		served['https://api.modpacks.ch/public/mod/400/versions/1.20.1/2'] = () =>
			Response.json({ versions: [mirrorFile({ id: 4001, name: 'old-mod-1.jar' })], page: 2, pages: 2 });
		serve('https://files.test/cf/old-mod-1.jar', 'old mod');

		const upload = parsePack(
			zipBuffer({
				'manifest.json': JSON.stringify({
					minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-0.15.0', primary: true }] },
					name: 'Uploaded',
					version: '1',
					files: [{ projectID: 400, fileID: 4001, required: true }],
					overrides: 'overrides'
				}),
				'overrides/config/x.cfg': 'x'
			})
		);
		const { instance, taskId } = await createFromPack('Uploaded', upload, { source: 'manual' });
		expect((await waitForTask(taskId)).state).toBe('done');
		expect(await tree(instance.path)).toMatchObject({ 'mods/old-mod-1.jar': 'old mod', 'config/x.cfg': 'x' });
		expect((await listInstanceMods(reload(instance.id)))[0]).toMatchObject({
			source: 'curseforge',
			slug: '400',
			name: 'Old Mod',
			versionId: '4001'
		});
	});

	it('disables client-only mods a pack brings and says so', async () => {
		fakeInstall('fabric');
		const base = `https://files.test/${++packs}`;
		serve(`${base}/content.jar`, zipBuffer({ 'fabric.mod.json': '{"id":"content"}' }));
		serve(`${base}/shaders.jar`, zipBuffer({ 'fabric.mod.json': '{"id":"shaders","environment":"client"}' }));
		const withClientMod = packFromFileList({
			name: 'Client Mod Pack',
			version: '1.0',
			minecraftVersion: '1.20.1',
			modloader: 'fabric',
			modloaderVersion: null,
			files: [
				{ path: 'mods/', name: 'content.jar', url: `${base}/content.jar` },
				{ path: 'mods/', name: 'shaders.jar', url: `${base}/shaders.jar` }
			]
		});
		const { instance, taskId } = await createFromPack('Client Mods', withClientMod, { source: 'curseforge' });
		expect((await waitForTask(taskId)).state).toBe('done');

		const files = Object.keys(await tree(instance.path));
		expect(files).toEqual(expect.arrayContaining(['mods/content.jar', 'mods/shaders.jar.disabled']));
		expect(reload(instance.id).statusMessage).toMatch(/Disabled 1 client-only mod \(shaders\)/);
	});

	it('installs the form’s choices: unticked mods disabled, a ticked client-only one kept, a ticked pack-disabled one enabled', async () => {
		fakeInstall('fabric');
		const base = `https://files.test/${++packs}`;
		serve(`${base}/content.jar`, zipBuffer({ 'fabric.mod.json': '{"id":"content"}' }));
		serve(`${base}/extra.jar`, zipBuffer({ 'fabric.mod.json': '{"id":"extra"}' }));
		serve(`${base}/shaders.jar`, zipBuffer({ 'fabric.mod.json': '{"id":"shaders","environment":"client"}' }));
		// Shipped disabled by the pack (Thread does that to Fabric API).
		serve(`${base}/api.jar.disabled`, zipBuffer({ 'fabric.mod.json': '{"id":"api"}' }));
		const chosen = packFromFileList({
			name: 'Chosen',
			version: '1.0',
			minecraftVersion: '1.20.1',
			modloader: 'fabric',
			modloaderVersion: null,
			files: ['content.jar', 'extra.jar', 'shaders.jar', 'api.jar.disabled'].map((name) => ({ path: 'mods/', name, url: `${base}/${name}` }))
		});
		const { instance, taskId } = await createFromPack(
			'Chosen',
			chosen,
			{ source: 'curseforge' },
			{ disableMods: ['mods/extra.jar'], keepMods: ['mods/shaders.jar'], enableMods: ['mods/api.jar.disabled'] }
		);
		expect((await waitForTask(taskId)).state).toBe('done');

		expect(Object.keys(await tree(instance.path))).toEqual(
			expect.arrayContaining(['mods/content.jar', 'mods/extra.jar.disabled', 'mods/shaders.jar', 'mods/api.jar'])
		);
		expect(reload(instance.id).statusMessage).toBeNull();
	});

	it('starts the server once installed when asked, accepting the EULA', async () => {
		fakeInstall('fabric');
		const { instance, taskId } = await createFromPack('Started', pack(), { source: 'curseforge' }, { startWhenReady: true });
		expect((await waitForTask(taskId)).state).toBe('done');
		expect((await tree(instance.path))['eula.txt']).toMatch(/^eula=true$/m);
		expect(spawnCalls.some((c) => c.args.includes('start') && c.args.some((a) => a.includes(instance.id)))).toBe(true);
	});

	it('does not start a pack that is missing mods', async () => {
		fakeInstall('fabric');
		const { instance, taskId } = await createFromPack('Not Started', pack({ missing: true }), { source: 'curseforge' }, { startWhenReady: true });
		expect((await waitForTask(taskId)).log.join('\n')).toMatch(/Not starting the server: some mods could not be downloaded/);
		// "& start" says it accepts the EULA, and does so at once (the page does not ask while it installs).
		expect(Object.keys(await tree(instance.path))).toContain('eula.txt');
		expect(spawnCalls.some((c) => c.args.includes('start') && c.args.some((a) => a.includes(instance.id)))).toBe(false);
	});
});
