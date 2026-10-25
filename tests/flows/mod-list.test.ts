import { describe, expect, it } from 'vitest';

const { modListEntries } = await import('#lib/server/modlist.js');
const { recordInstanceMod, trackManualJar, upsertMod } = await import('#lib/server/mods/index.js');
const { createInstance } = await import('../helpers/instances');
const { zipBuffer } = await import('../helpers/fs');

/** The mod list export: what each mod is called, its version and authors (modlist.ts). */
describe('mod list entries', () => {
	it('names and links tracked mods from the record, versions and authors from the jar', async () => {
		const instance = await createInstance({ modloader: 'forge', minecraftVersion: '1.20.1' }, {
			// Recorded from CurseForge: the file name stands in for the version, one author only.
			'mods/jei.jar': zipBuffer({
				'META-INF/mods.toml': '[[mods]]\nmodId="jei"\nversion="15.2.0.27"\ndisplayName="JEI"\nauthors="mezz, Alice and Bob"\n[[dependencies.jei]]\nmodId="forge"\nversion="[47,)"\n'
			}),
			// Unrecorded, and the build left the version placeholder in.
			'mods/handmade.jar': zipBuffer({
				'META-INF/mods.toml': '[[mods]]\nmodId="handmade"\nversion="${file.jarVersion}"\ndisplayName="Hand Made"\n'
			}),
			'mods/fabricmod.jar.disabled': zipBuffer({
				'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'fab', name: 'Fab', version: '2.0', authors: ['Ann', { name: 'Ben' }], environment: 'client' })
			}),
			// Recorded as uploaded, which names it after the file.
			'mods/sodium-0.6.0.jar': zipBuffer({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'sodium', name: 'Sodium', version: '0.6.0' }) }),
			'mods/old.jar': zipBuffer({ 'mcmod.info': '[{"modid":"old","name":"Old Mod","version":"1.0","authorList":["Cpw","Lex"]}]' }),
			// Recorded, with an author, and nothing in the jar.
			'mods/plain.jar': zipBuffer({ 'readme.txt': 'nothing' })
		});
		const record = (file: string, slug: string, name: string, author: string | null, version: string) =>
			recordInstanceMod({
				instanceId: instance.id,
				modId: upsertMod({ source: 'curseforge', slug, name, author, projectUrl: `https://cf.test/${slug}` }),
				version,
				versionId: null,
				filePath: `mods/${file}`,
				hash: null,
				hashAlgo: null,
				fromPack: true
			});
		record('jei.jar', 'modlist-jei', 'Just Enough Items', 'mezz', 'jei-1.20.1-forge-15.2.0.27');
		record('plain.jar', 'modlist-plain', 'Plain', 'Someone', '3.1');
		await trackManualJar(instance, 'sodium-0.6.0.jar');

		expect(await modListEntries(instance)).toEqual([
			{ name: 'Fab', version: '2.0', authors: ['Ann', 'Ben'], url: null, file: 'fabricmod.jar.disabled', enabled: false, clientOnly: true },
			{ name: 'Hand Made', version: null, authors: [], url: null, file: 'handmade.jar', enabled: true, clientOnly: false },
			{ name: 'Just Enough Items', version: '15.2.0.27', authors: ['mezz', 'Alice', 'Bob'], url: 'https://cf.test/modlist-jei', file: 'jei.jar', enabled: true, clientOnly: false },
			{ name: 'Old Mod', version: '1.0', authors: ['Cpw', 'Lex'], url: null, file: 'old.jar', enabled: true, clientOnly: false },
			{ name: 'Plain', version: '3.1', authors: ['Someone'], url: 'https://cf.test/modlist-plain', file: 'plain.jar', enabled: true, clientOnly: false },
			{ name: 'Sodium', version: '0.6.0', authors: [], url: null, file: 'sodium-0.6.0.jar', enabled: true, clientOnly: false }
		]);
	});
});
