import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ServerInstance } from '#lib/server/db/schema.js';

const { exportResult, planExport, startExport } = await import('#lib/server/packexport.js');
const { recordInstanceMod, upsertMod } = await import('#lib/server/mods/index.js');
const { openZipBuffer } = await import('#lib/server/zip.js');
const { createInstance, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');

const sha = (algo: string, body: string | Buffer) => crypto.createHash(algo).update(body).digest('hex');

// The server's mods. sodium.jar and ledger.jar (a server-only project) are on Modrinth.
const MODS = {
	sodium: 'sodium bytes',
	ledger: 'ledger bytes',
	jei: 'jei bytes',
	zoom: 'zoom bytes',
	spare: 'spare bytes',
	mine: 'my own jar'
};

/** A Modrinth version record for a file, as version_files answers it. */
function mrVersion(project: string, file: string, body: string) {
	return {
		id: `v-${project}`,
		project_id: project,
		name: project,
		version_number: '1.0',
		version_type: 'release',
		date_published: '2026-01-01T00:00:00Z',
		game_versions: ['1.20.1'],
		loaders: ['fabric'],
		changelog: null,
		files: [{ filename: file, url: `https://cdn.modrinth.com/data/${project}/versions/1/${file}`, primary: true, size: body.length, hashes: { sha1: sha('sha1', body), sha512: sha('sha512', body) } }],
		dependencies: []
	};
}

const SHADER = 'shader pack bytes';
const MRPACK = zipBuffer({
	'modrinth.index.json': JSON.stringify({
		formatVersion: 1,
		game: 'minecraft',
		versionId: '2.0',
		name: 'Test Pack',
		dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.9' },
		files: [
			// On the server already: not added twice.
			{ path: 'mods/sodium.jar', hashes: { sha1: sha('sha1', MODS.sodium), sha512: sha('sha512', MODS.sodium) }, downloads: ['https://cdn.modrinth.com/x/sodium.jar'], env: { client: 'required', server: 'unsupported' } },
			// Client-only, never put on the server: added.
			{ path: 'shaderpacks/pretty.zip', hashes: { sha1: sha('sha1', SHADER), sha512: sha('sha512', SHADER) }, downloads: ['https://cdn.modrinth.com/x/pretty.zip'], fileSize: SHADER.length, env: { client: 'required', server: 'unsupported' } },
			// A server mod the user removed: stays out.
			{ path: 'mods/removed.jar', hashes: { sha1: 'aa', sha512: 'bb' }, downloads: ['https://cdn.modrinth.com/x/removed.jar'], env: { client: 'required', server: 'required' } }
		]
	}),
	'overrides/config/shared.cfg': 'pack version of shared',
	'client-overrides/options.txt': 'fov:90',
	'overrides/world/level.dat': 'never'
});

useRecordedHttp('none', {
	extra: {
		'https://api.modrinth.com/v2/version_files': (init) => {
			const { hashes } = JSON.parse(String(init?.body)) as { hashes: string[] };
			const known = [mrVersion('sodium', 'sodium.jar', MODS.sodium), mrVersion('ledger', 'ledger.jar', MODS.ledger)];
			return Response.json(Object.fromEntries(known.filter((v) => hashes.includes(v.files[0].hashes.sha512)).map((v) => [v.files[0].hashes.sha512, v])));
		},
		'https://api.modrinth.com/v2/version/pack-v2': () =>
			Response.json({ ...mrVersion('pack', 'pack.mrpack', 'x'), files: [{ filename: 'pack.mrpack', url: 'https://cdn.modrinth.com/pack.mrpack', primary: true, size: 1, hashes: {} }] }),
		'https://api.modrinth.com/v2/project/pack': () => Response.json({ id: 'pack', slug: 'pack', title: 'Test Pack', description: '', icon_url: null, downloads: 0, loaders: [], game_versions: [], team: 't' }),
		'https://cdn.modrinth.com/pack.mrpack': () => new Response(new Uint8Array(MRPACK)),
		'https://cdn.modrinth.com/x/pretty.zip': () => new Response(SHADER),
		// A CurseForge pack version as the modpacks.ch mirror lists it, client-only files included.
		'https://api.modpacks.ch/public/curseforge/900/901': () =>
			Response.json({
				id: 901,
				name: '3.0',
				type: 'release',
				updated: 0,
				files: [
					{ name: 'jei.jar', path: './mods/', url: 'https://files.test/jei.jar', curseforge: { project: 238222, file: 4712866 } },
					{ name: 'minimap.jar', path: './mods/', url: 'https://files.test/minimap.jar', clientonly: true, curseforge: { project: 555, file: 666 } },
					{ name: 'overrides.zip', path: './', url: 'https://files.test/overrides.zip' }
				]
			}),
		'https://files.test/minimap.jar': () => new Response('minimap bytes'),
		'https://files.test/overrides.zip': () =>
			new Response(new Uint8Array(zipBuffer({ 'overrides/config/shared.cfg': 'pack', 'overrides/resourcepacks/hd.zip': 'hd' })))
	}
});

async function server(fields: Partial<ServerInstance> = {}) {
	const instance = await createInstance(
		{ modloader: 'fabric', modloaderVersion: '0.16.9', minecraftVersion: '1.20.1', ...fields },
		{
			'mods/sodium.jar.disabled': MODS.sodium,
			'mods/ledger.jar': MODS.ledger,
			'mods/jei.jar': MODS.jei,
			'mods/zoom.jar.disabled': MODS.zoom,
			'mods/spare.jar.disabled': MODS.spare,
			'mods/mine.jar': MODS.mine,
			'config/shared.cfg': 'server version of shared',
			'kubejs/startup.js': '//',
			'world/level.dat': 'world',
			'logs/latest.log': 'log',
			'server.properties': 'level-name=world',
			'notes.txt': 'admin notes'
		}
	);
	const track = (file: string, source: 'modrinth' | 'curseforge', slug: string, versionId: string, clientOnly = false) =>
		recordInstanceMod({ instanceId: instance.id, modId: upsertMod({ source, slug, name: slug }), version: '1', versionId, filePath: `mods/${file}`, hash: null, hashAlgo: null, fromPack: false, clientOnly });
	track('sodium.jar', 'modrinth', 'sodium', 'v-sodium', true);
	track('jei.jar', 'curseforge', '238222', '4712866');
	track('zoom.jar', 'curseforge', '111', '222', true);
	track('spare.jar', 'curseforge', '333', '444');
	return instance;
}

async function exported(instance: ServerInstance, format: 'mrpack' | 'curseforge' | 'prism') {
	const plan = await planExport(instance);
	const taskId = await startExport(instance, {
		format,
		name: 'My Pack',
		version: '1.0',
		mods: plan.mods.map((m) => m.file),
		folders: plan.folders.filter((f) => f.include).map((f) => f.name)
	});
	const task = await waitForTask(taskId);
	expect(task.error).toBeNull();
	const zip = openZipBuffer(await fs.readFile(exportResult(instance.id, taskId)!.file))!;
	return { zip, names: zip.entries.map((e) => e.name).sort() };
}

describe('client pack export', () => {
	it('plans: every mod, client-only ones enabled, server files never offered', async () => {
		const plan = await planExport(await server());
		const mod = (file: string) => plan.mods.find((m) => m.file === file)!;
		expect(mod('ledger.jar')).toMatchObject({ enabled: true, clientOnly: false });
		expect(mod('sodium.jar.disabled')).toMatchObject({ enabled: true, clientOnly: true });
		expect(mod('spare.jar.disabled').enabled).toBe(false);
		expect(plan.folders).toEqual([
			{ name: 'config', dir: true, include: true },
			{ name: 'kubejs', dir: true, include: true },
			{ name: 'notes.txt', dir: false, include: false }
		]);
	});

	it('Modrinth: links Modrinth files, bundles the rest, keeps disabled mods disabled', async () => {
		const { zip, names } = await exported(await server(), 'mrpack');
		const index = JSON.parse(zip.readText('modrinth.index.json')!);
		expect(index.dependencies).toEqual({ minecraft: '1.20.1', 'fabric-loader': '0.16.9' });
		expect(index.files.map((f: { path: string }) => f.path)).toEqual(['mods/ledger.jar', 'mods/sodium.jar']);
		expect(index.files[1].downloads).toEqual(['https://cdn.modrinth.com/data/sodium/versions/1/sodium.jar']);
		expect(names).toEqual([
			'modrinth.index.json',
			'overrides/config/shared.cfg',
			'overrides/kubejs/startup.js',
			'overrides/mods/jei.jar',
			'overrides/mods/mine.jar',
			'overrides/mods/spare.jar.disabled',
			'overrides/mods/zoom.jar'
		]);
	});

	it('CurseForge: links CurseForge files by id, bundles disabled ones and the rest', async () => {
		const { zip, names } = await exported(await server(), 'curseforge');
		const manifest = JSON.parse(zip.readText('manifest.json')!);
		expect(manifest.minecraft).toEqual({ version: '1.20.1', modLoaders: [{ id: 'fabric-0.16.9', primary: true }] });
		// In mod-name order, and the mods table is shared by every test file in a run: another
		// file's project 111 under another name reordered this list. The order means nothing.
		expect(manifest.files).toHaveLength(2);
		expect(manifest.files).toEqual(
			expect.arrayContaining([
				{ projectID: 111, fileID: 222, required: true },
				{ projectID: 238222, fileID: 4712866, required: true }
			])
		);
		expect(names).toContain('overrides/mods/sodium.jar');
		expect(names).toContain('overrides/mods/spare.jar.disabled');
		expect(names).not.toContain('overrides/mods/jei.jar');
	});

	it('Prism: everything bundled under .minecraft, with the loader as components', async () => {
		const { zip, names } = await exported(await server(), 'prism');
		expect(JSON.parse(zip.readText('mmc-pack.json')!).components).toEqual([
			{ uid: 'net.minecraft', version: '1.20.1', important: true },
			{ uid: 'net.fabricmc.intermediary', version: '1.20.1', dependencyOnly: true },
			{ uid: 'net.fabricmc.fabric-loader', version: '0.16.9' }
		]);
		expect(zip.readText('instance.cfg')).toContain('name=My Pack');
		expect(names.filter((n) => n.startsWith('.minecraft/mods/'))).toEqual([
			'.minecraft/mods/jei.jar',
			'.minecraft/mods/ledger.jar',
			'.minecraft/mods/mine.jar',
			'.minecraft/mods/sodium.jar',
			'.minecraft/mods/spare.jar.disabled',
			'.minecraft/mods/zoom.jar'
		]);
		expect(names.some((n) => n.includes('world') || n.includes('logs') || n.includes('server.properties'))).toBe(false);
	});

	it("adds a Modrinth pack's client files the server never had, not ones removed on purpose", async () => {
		const instance = await server({ packSource: 'modrinth', packProjectId: 'pack', packVersionId: 'pack-v2', packName: 'Test Pack' });
		const { zip, names } = await exported(instance, 'mrpack');
		const files = JSON.parse(zip.readText('modrinth.index.json')!).files.map((f: { path: string }) => f.path);
		expect(files).toEqual(['mods/ledger.jar', 'mods/sodium.jar', 'shaderpacks/pretty.zip']);
		expect(names).toContain('overrides/options.txt');
		// The server's edited config wins over the pack's.
		expect(zip.readText('overrides/config/shared.cfg')).toBe('server version of shared');
		expect(names.some((n) => n.includes('removed.jar') || n.includes('level.dat'))).toBe(false);
	});

	it("adds a mirror pack's client-only mods (linked by id) and override files the server lacks", async () => {
		const instance = await server({ packSource: 'curseforge', packProjectId: '900', packVersionId: '901', packName: 'CF Pack' });
		const cf = await exported(instance, 'curseforge');
		expect(JSON.parse(cf.zip.readText('manifest.json')!).files).toContainEqual({ projectID: 555, fileID: 666, required: true });
		expect(cf.names).toContain('overrides/resourcepacks/hd.zip');
		expect(cf.zip.readText('overrides/config/shared.cfg')).toBe('server version of shared');
		// Prism has no links: the client-only mod is downloaded into the instance.
		const prism = await exported(instance, 'prism');
		expect(prism.zip.readText('.minecraft/mods/minimap.jar')).toBe('minimap bytes');
	});
});
