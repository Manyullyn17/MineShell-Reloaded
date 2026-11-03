import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

const { listInstanceMods, recordInstanceMod, upsertMod } = await import('#lib/server/mods/index.js');
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
