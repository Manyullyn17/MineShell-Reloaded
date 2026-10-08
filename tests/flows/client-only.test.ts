import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

const { disableClientOnlyMods, describeClientOnlyResult } = await import('#lib/server/clientonly.js');
const { listInstanceMods, recordInstanceMod, syncMods, upsertMod } = await import('#lib/server/mods/index.js');
const { createInstance, tree } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');

const fabricJar = (id: string, extra: Record<string, unknown> = {}) =>
	zipBuffer({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, name: id, ...extra }) });

// Looks like any other mod; only Modrinth knows it is client-only (Iris, Missing Mods Checker).
const SHADERS = fabricJar('shaders');
const sha512 = (b: Buffer) => crypto.createHash('sha512').update(b).digest('hex');

const modrinthVersion = (projectId: string) => ({
	id: `${projectId}-v`,
	project_id: projectId,
	name: '1.0',
	version_number: '1.0',
	version_type: 'release',
	date_published: '2026-01-01T00:00:00Z',
	game_versions: ['1.21.1'],
	loaders: ['fabric'],
	changelog: null,
	files: [],
	dependencies: []
});

// CurseForge projects, as the mirror lists their files for Forge 1.12.2 (newest first).
const cfFile = (id: number, updated: number, clientonly?: boolean) => ({
	id, name: `file-${id}.jar`, type: 'release', updated, url: `https://cdn.test/${id}.jar`, ...(clientonly ? { clientonly } : {})
});
const CF_FILES: Record<string, ReturnType<typeof cfFile>[]> = {
	// Only the newest file was tagged, later (Mouse Tweaks for 1.12.2).
	'111': [cfFile(12, 200, true), cfFile(11, 100)],
	// The installed file itself is tagged.
	'222': [cfFile(21, 100, true)],
	// A content mod: nothing tagged.
	'333': [cfFile(32, 200), cfFile(31, 100)]
};

const modrinthDown = { fail: false };
useRecordedHttp('none', {
	extra: {
		...Object.fromEntries(
			Object.entries(CF_FILES).map(([id, versions]) => [
				`https://api.modpacks.ch/public/mod/${id}/versions/1.12.2/forge`,
				() => Response.json({ versions, page: 1, pages: 1 })
			])
		),
		'https://api.modpacks.ch/public/mod/444/versions/1.12.2/forge': () => new Response('down', { status: 503 }),
		'https://api.modrinth.com/v2/version_files': () =>
			modrinthDown.fail
				? new Response('down', { status: 503 })
				: Response.json({ [sha512(SHADERS)]: modrinthVersion('SHADERS') }),
		[`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent('["SHADERS"]')}`]: () =>
			Response.json([
				{
					id: 'SHADERS',
					slug: 'shaders',
					title: 'Shaders',
					description: '',
					icon_url: null,
					downloads: 1,
					loaders: ['fabric'],
					game_versions: ['1.21.1'],
					team: 't',
					// A list, which the old string comparison never matched.
					environment: ['client_only']
				}
			])
	}
});

async function fabricInstance(mods: Record<string, Buffer>) {
	const files = Object.fromEntries(Object.entries(mods).map(([name, jar]) => [`mods/${name}`, jar]));
	const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, files);
	await syncMods(instance, { fromPack: true });
	return instance;
}

describe('client-only mods in a server install', () => {
	it('disables what Modrinth lists as client-only and what declares itself so', async () => {
		const instance = await fabricInstance({
			'shaders.jar': SHADERS,
			'minimap.jar': fabricJar('minimap', { environment: 'client' }),
			'content.jar': fabricJar('content')
		});
		const result = await disableClientOnlyMods(instance, ['shaders.jar', 'minimap.jar', 'content.jar']);

		expect(result.disabled.map((d) => [d.fileName, d.reason]).sort()).toEqual([
			['minimap.jar', 'the mod declares itself client-only'],
			['shaders.jar', 'Modrinth lists it as client-only']
		]);
		expect(Object.keys(await tree(instance.path)).sort()).toEqual([
			'mods/content.jar',
			'mods/minimap.jar.disabled',
			'mods/shaders.jar.disabled'
		]);
		const rows = Object.fromEntries((await listInstanceMods(instance)).map((m) => [m.fileName, m]));
		expect(rows['shaders.jar.disabled']).toMatchObject({ name: 'Shaders', source: 'modrinth', clientOnly: true });
		expect(rows['content.jar'].clientOnly).toBe(false);
		expect(describeClientOnlyResult(result)).toMatch(/^Disabled 2 client-only mods \(.*Shaders.*\)/);
	});

	it('keeps a client-only mod that an enabled mod requires, and what that one requires', async () => {
		// The pattern behind "server mod needs a client-only library": disabling
		// it only trades one crash for another.
		const instance = await fabricInstance({
			'lib.jar': fabricJar('lib', { environment: 'client', depends: { corelib: '*' } }),
			'corelib.jar': fabricJar('corelib', { environment: 'client' }),
			'machine.jar': fabricJar('machine', { depends: { lib: '>=1', minecraft: '*' } })
		});
		const result = await disableClientOnlyMods(instance, ['lib.jar', 'corelib.jar', 'machine.jar']);
		expect(result.disabled).toEqual([]);
		expect(result.kept.map((k) => [k.fileName, k.neededBy]).sort()).toEqual([
			['corelib.jar', ['lib']],
			['lib.jar', ['machine']]
		]);
	});

	it('reads required dependencies from Forge, NeoForge and 1.12 metadata', async () => {
		const forgeJar = (id: string, deps: string) =>
			zipBuffer({ 'META-INF/mods.toml': `modLoader="javafml"\n[[mods]]\nmodId="${id}"\n${deps}` });
		const instance = await createInstance({ modloader: 'forge', minecraftVersion: '1.20.1' }, {
			'mods/a.jar': fabricJar('a', { environment: 'client' }),
			'mods/b.jar': fabricJar('b', { environment: 'client' }),
			'mods/c.jar': fabricJar('c', { environment: 'client' }),
			'mods/d.jar': fabricJar('d', { environment: 'client' }),
			'mods/needs-a.jar': forgeJar('needsa', '[[dependencies.needsa]]\nmodId="a"\nmandatory=true\n'),
			'mods/needs-b.jar': forgeJar('needsb', '[[dependencies.needsb]]\nmodId="b"\ntype="required"\n'),
			'mods/maybe-c.jar': forgeJar('maybec', '[[dependencies.maybec]]\nmodId="c"\nmandatory=false\n'),
			'mods/old.jar': zipBuffer({ 'mcmod.info': '[{"modid":"old","name":"Old","requiredMods":["d@[1.0,)"]}]' })
		});
		await syncMods(instance, { fromPack: true });
		const result = await disableClientOnlyMods(instance, ['a.jar', 'b.jar', 'c.jar', 'd.jar']);
		expect(result.kept.map((k) => k.fileName).sort()).toEqual(['a.jar', 'b.jar', 'd.jar']);
		expect(result.disabled.map((d) => d.fileName)).toEqual(['c.jar']);
	});

	it('leaves jars it was not asked about alone, so a re-enabled mod stays on', async () => {
		const instance = await fabricInstance({ 'minimap.jar': fabricJar('minimap', { environment: 'client' }) });
		const result = await disableClientOnlyMods(instance, ['something-new.jar']);
		expect(result.disabled).toEqual([]);
		expect(Object.keys(await tree(instance.path))).toEqual(['mods/minimap.jar']);
	});

	it('still acts on what the jars say when Modrinth is down', async () => {
		modrinthDown.fail = true;
		try {
			const instance = await fabricInstance({
				'shaders.jar': SHADERS,
				'minimap.jar': fabricJar('minimap', { environment: 'client' })
			});
			const result = await disableClientOnlyMods(instance, ['shaders.jar', 'minimap.jar']);
			expect(result.disabled.map((d) => d.fileName)).toEqual(['minimap.jar']);
		} finally {
			modrinthDown.fail = false;
		}
	});

	it('flags the jar in its own instance only', async () => {
		// Manual mods share one record per file name; a flag there disabled an
		// unrelated a.jar in another server.
		const first = await fabricInstance({ 'a.jar': fabricJar('a', { environment: 'client' }) });
		await disableClientOnlyMods(first, ['a.jar']);
		const second = await fabricInstance({ 'a.jar': fabricJar('something-else') });
		expect((await disableClientOnlyMods(second, ['a.jar'])).disabled).toEqual([]);
		expect((await listInstanceMods(second))[0].clientOnly).toBe(false);
	});

	it('does not mistake a dependency on Minecraft for being Minecraft', async () => {
		// Missing Mods Checker ships a mods.toml whose dependency block names
		// "minecraft"; every mod requires minecraft, so it was always kept.
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, {
			'mods/checker.jar': zipBuffer({
				'fabric.mod.json': JSON.stringify({ id: 'checker', environment: 'client' }),
				'META-INF/mods.toml': '[[mods]]\nmodId="checker"\n[[dependencies."checker"]]\nmodId="minecraft"\nmandatory=true\n'
			}),
			'mods/content.jar': fabricJar('content', { depends: { minecraft: '>=1.21' } })
		});
		await syncMods(instance, { fromPack: true });
		const result = await disableClientOnlyMods(instance, ['checker.jar']);
		expect(result.disabled.map((d) => d.fileName)).toEqual(['checker.jar']);
	});

	it('disables CurseForge mods CurseForge tags as client-only, or whose newest file it tags', async () => {
		// The mirror's pack file lists leave tagged files out, but uploaded zips
		// and older files (tagged only on the newest) got through.
		const jars = { 'mousetweaks.jar': '111/11', 'betterfoliage.jar': '222/21', 'content.jar': '333/31', 'unknown.jar': '444/41' };
		const instance = await createInstance(
			{ modloader: 'forge', minecraftVersion: '1.12.2' },
			Object.fromEntries(Object.keys(jars).map((f) => [`mods/${f}`, zipBuffer({ 'mcmod.info': `[{"modid":"${f}","name":"${f}"}]` })]))
		);
		for (const [fileName, ref] of Object.entries(jars)) {
			const [project, file] = ref.split('/');
			const modId = upsertMod({ source: 'curseforge', slug: project, name: fileName });
			recordInstanceMod({ instanceId: instance.id, modId, version: file, versionId: file, filePath: `mods/${fileName}`, hash: null, hashAlgo: null, fromPack: true });
		}
		const result = await disableClientOnlyMods(instance, Object.keys(jars));
		expect(result.disabled.map((d) => [d.fileName, d.reason]).sort()).toEqual([
			['betterfoliage.jar', 'CurseForge tags it as client-only'],
			['mousetweaks.jar', 'CurseForge tags its newest file for 1.12.2 as client-only']
		]);
		expect(Object.keys(await tree(instance.path)).sort()).toEqual([
			'mods/betterfoliage.jar.disabled',
			'mods/content.jar',
			'mods/mousetweaks.jar.disabled',
			'mods/unknown.jar'
		]);
	});
});
