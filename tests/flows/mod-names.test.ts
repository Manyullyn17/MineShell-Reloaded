import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

const { listInstanceMods, recordInstanceMod, trackManualJar, upsertMod } = await import('#lib/server/mods/index.js');
const { db } = await import('#lib/server/db/index.js');
const { mods } = await import('#lib/server/db/schema.js');
const { createInstance } = await import('../helpers/instances');
const { zipBuffer, mcmodInfo } = await import('../helpers/fs');

// Project ids no other test uses: the mods table is shared by every test file in a run.
const JARS: Record<string, { project: string; jar: Buffer }> = {
	'litematica-fabric.jar': { project: '91205459', jar: zipBuffer({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'litematica', name: 'Litematica' }) }) },
	'quiltmod.jar': { project: '91205460', jar: zipBuffer({ 'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'quiltmod', version: '1.0', metadata: { name: 'Quilt Mod' } } }) }) },
	'forgemod.jar': { project: '91205461', jar: zipBuffer({ 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="forgemod"\ndisplayName="Forge Mod"\n' }) },
	'neomod.jar': { project: '91205462', jar: zipBuffer({ 'META-INF/neoforge.mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="neomod"\ndisplayName="Neo Mod"\n' }) },
	'oldmod.jar': { project: '91205463', jar: zipBuffer({ 'mcmod.info': mcmodInfo('oldmod', 'Old Mod') }) },
	// Nothing usable to name it by: the template's unreplaced property, and no metadata at all.
	'template.jar': { project: '91205464', jar: zipBuffer({ 'META-INF/mods.toml': '[[mods]]\nmodId="template"\ndisplayName="${mod_name}"\n' }) },
	'bare.jar': { project: '91205465', jar: zipBuffer({ 'readme.txt': 'no metadata' }) }
};

describe('CurseForge projects named "project-<id>"', () => {
	it("are shown and kept under the name their jar declares, on every loader's metadata", async () => {
		const instance = await createInstance(
			{ modloader: 'fabric', minecraftVersion: '1.21.11' },
			Object.fromEntries(Object.entries(JARS).map(([fileName, { jar }]) => [`mods/${fileName}`, jar]))
		);
		for (const [fileName, { project }] of Object.entries(JARS)) {
			const modId = upsertMod({ source: 'curseforge', slug: project, name: `project-${project}` });
			recordInstanceMod({ instanceId: instance.id, modId, version: '1.0', versionId: '1', filePath: `mods/${fileName}`, hash: null, hashAlgo: null, fromPack: true });
		}
		const names = Object.fromEntries((await listInstanceMods(instance)).map((r) => [r.fileName, r.name]));
		expect(names).toEqual({
			'litematica-fabric.jar': 'Litematica',
			'quiltmod.jar': 'Quilt Mod',
			'forgemod.jar': 'Forge Mod',
			'neomod.jar': 'Neo Mod',
			'oldmod.jar': 'Old Mod',
			'template.jar': 'project-91205464',
			'bare.jar': 'project-91205465'
		});
		// Kept on the mod's row, for update lists and notifications.
		expect(db.select({ name: mods.name }).from(mods).where(eq(mods.slug, '91205459')).get()?.name).toBe('Litematica');
	});

	it('leaves a real name alone, even one that starts with "project"', async () => {
		const instance = await createInstance(
			{ modloader: 'forge', minecraftVersion: '1.12.2' },
			{ 'mods/projectred.jar': zipBuffer({ 'mcmod.info': mcmodInfo('projectred-core', 'ProjectRed Core') }) }
		);
		const modId = upsertMod({ source: 'curseforge', slug: '91205466', name: 'Project Red - Core' });
		recordInstanceMod({ instanceId: instance.id, modId, version: '1.0', versionId: '1', filePath: 'mods/projectred.jar', hash: null, hashAlgo: null, fromPack: true });
		expect((await listInstanceMods(instance)).map((r) => r.name)).toEqual(['Project Red - Core']);
	});
});

// Jars no catalog knows: named and versioned after what they declare, not after their file.
const toml = (blocks: { id: string; name: string; version: string }[]) =>
	'modLoader="javafml"\n' + blocks.map((b) => `[[mods]]\nmodId="${b.id}"\ndisplayName="${b.name}"\nversion="${b.version}"\n`).join('');
const MANUAL: Record<string, Buffer> = {
	// Several mods in one jar: the one the file is named after.
	'buildcraft-core-8.0.0.jar': zipBuffer({ 'META-INF/mods.toml': toml([{ id: 'buildcraftlib', name: 'BuildCraft Lib', version: '8.0.0' }, { id: 'buildcraftcore', name: 'BuildCraft', version: '8.0.0' }]) }),
	'ProjectRed-1.12.2-4.9.4-integration.jar': zipBuffer({
		'META-INF/mods.toml': toml([{ id: 'projectred-transmission', name: 'ProjectRed Transmission', version: '4.9.4' }, { id: 'projectred-integration', name: 'ProjectRed Integration', version: '4.9.4' }])
	}),
	// A Fabric stub for players on the wrong loader beside the real NeoForge mod.
	'journeymap-neoforge-1.21.1-6.0.9.jar': zipBuffer({
		'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'journeymap-wrongloader', name: 'Journeymap-NeoForge', version: 'not a fabric mod' }),
		'META-INF/neoforge.mods.toml': toml([{ id: 'journeymap', name: 'Journeymap', version: '${file.jarVersion}' }]),
		'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Version: 1.21.1-6.0.9\r\n'
	}),
	// mcmod.info that is not strict JSON (a line break inside a string), as Iron Chest's.
	'ironchest-1.12.2-7.0.72.jar': zipBuffer({ 'mcmod.info': '[{\n"modid": "ironchest",\n"name": "Iron Chest",\n"description": "New chests.\nLarger ones.",\n"version": "1.12.2-7.0.67"\n}]' }),
	// The template's name, never changed: the file name says more.
	'careerbees-0.4.0.jar': zipBuffer({ 'mcmod.info': mcmodInfo('examplemod', 'Example Mod') })
};

describe('jars no catalog knows', () => {
	const expected = {
		'buildcraft-core-8.0.0.jar': { name: 'BuildCraft', version: '8.0.0' },
		'ProjectRed-1.12.2-4.9.4-integration.jar': { name: 'ProjectRed Integration', version: '4.9.4' },
		'journeymap-neoforge-1.21.1-6.0.9.jar': { name: 'Journeymap', version: '1.21.1-6.0.9' },
		'ironchest-1.12.2-7.0.72.jar': { name: 'Iron Chest', version: '1.12.2-7.0.67' },
		'careerbees-0.4.0.jar': { name: 'careerbees-0.4.0', version: null }
	};
	const shown = async (instance: Awaited<ReturnType<typeof createInstance>>) =>
		Object.fromEntries((await listInstanceMods(instance)).map((r) => [r.fileName, { name: r.name, version: r.version }]));

	it('are recorded under the name and version they declare', async () => {
		const instance = await createInstance({ modloader: 'neoforge', minecraftVersion: '1.21.1' }, Object.fromEntries(Object.entries(MANUAL).map(([f, jar]) => [`mods/${f}`, jar])));
		for (const fileName of Object.keys(MANUAL)) await trackManualJar(instance, fileName);
		expect(await shown(instance)).toEqual(expected);
	});

	it('recorded before under their file name get it when listed', async () => {
		const instance = await createInstance({ modloader: 'neoforge', minecraftVersion: '1.21.1' }, Object.fromEntries(Object.entries(MANUAL).map(([f, jar]) => [`mods/${f}`, jar])));
		for (const fileName of Object.keys(MANUAL)) {
			// As trackManualJar left them before: the file name, no version (another server's jars, same names).
			const modId = upsertMod({ source: 'manual', slug: `old-${fileName}`, name: fileName.replace(/\.jar$/, '') });
			recordInstanceMod({ instanceId: instance.id, modId, version: null, versionId: null, filePath: `mods/${fileName}`, hash: null, hashAlgo: null, fromPack: false });
		}
		expect(await shown(instance)).toEqual(expected);
	});
});
