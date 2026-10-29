import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

/**
 * The update check on a Cleanroom server: Fugue builds are tied to Cleanroom
 * versions, so it offers the newest one that runs on the server's Cleanroom,
 * not the newest one. The catalog and downloads are stand-ins; the jars they
 * leave are read for real, as that is how MineShell tells what a Fugue needs.
 */

const FUGUE = vi.hoisted(() => [
	{ version: '0.25.5', range: '[0.7.3-alpha,)', date: '2026-10-16' },
	{ version: '0.24.4', range: '[0.6.10-alpha,)', date: '2026-09-01' },
	{ version: '0.23.7', range: '[0.5.14-alpha,)', date: '2026-07-01' },
	{ version: '0.23.4', range: '[0.5.7-alpha,)', date: '2026-05-01' }
]);
const fugueVersion = (f: (typeof FUGUE)[number]) => ({
	id: `fugue-${f.version}`,
	projectId: 'fugue',
	name: f.version,
	versionNumber: f.version,
	channel: 'release',
	datePublished: `${f.date}T00:00:00Z`,
	gameVersions: ['1.12.2'],
	loaders: ['forge'],
	changelog: null,
	files: [{ filename: `+Fugue-${f.version}.jar`, url: `https://cdn.test/fugue-${f.version}.jar`, primary: true }],
	dependencies: []
});

vi.mock('#lib/server/mods/index.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/mods/index.js')>()),
	getModProvider: (id: string) => ({
		id,
		listVersions: async () => FUGUE.map(fugueVersion),
		getVersion: async (_: string, versionId: string) => FUGUE.map(fugueVersion).find((v) => v.id === versionId) ?? null,
		getProject: async () => ({ id: 'fugue', slug: 'fugue', name: 'Fugue', projectUrl: null, iconUrl: null })
	})
}));
// Modrinth's "newest per file": the newest Fugue of all, whatever Cleanroom it needs.
vi.mock('#lib/server/mods/modrinth.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/mods/modrinth.js')>()),
	latestVersionsFromHashes: async (hashes: string[]) => new Map(hashes.map((h) => [h, fugueVersion(FUGUE[0])]))
}));
// What a download leaves: a Fugue jar declaring the Cleanroom it needs, as the real ones do.
vi.mock('#lib/server/download.js', async (importOriginal) => {
	const { zipBuffer } = await import('../helpers/fs');
	return {
		...(await importOriginal<typeof import('#lib/server/download.js')>()),
		downloadFile: async (url: string, dest: string) => {
			const range = FUGUE.find((f) => url.endsWith(`fugue-${f.version}.jar`))!.range;
			await fs.writeFile(dest, zipBuffer({ 'com/cleanroommc/fugue/Fugue.class': `\u0000required-after:cleanroom@${range};\u0000` }));
		}
	};
});

const { checkModUpdates } = await import('#lib/server/modupdates.js');
const { db } = await import('#lib/server/db/index.js');
const { instanceMods, mods } = await import('#lib/server/db/schema.js');
const { createInstance } = await import('../helpers/instances');
const { mcmodInfo, zipBuffer } = await import('../helpers/fs');

type Jar = { version: string; enabled?: boolean; clientOnly?: boolean; source?: 'modrinth' | 'curseforge' };

/** A Cleanroom server with these Fugue jars, tracked as Modrinth's. */
async function server(cleanroom: string, ...jars: (string | Jar)[]) {
	const all = jars.map((j) => (typeof j === 'string' ? { version: j } : j));
	const file = (j: Jar) => `+Fugue-${j.version}.jar${j.enabled === false ? '.disabled' : ''}`;
	const instance = await createInstance(
		{ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: cleanroom },
		// Each declares Fugue's mod id, as the real jars do; the version keeps them apart.
		Object.fromEntries(all.map((j) => [`mods/${file(j)}`, zipBuffer({ 'mcmod.info': mcmodInfo('fugue', 'Fugue'), version: j.version })]))
	);
	db.insert(mods).values({ source: 'modrinth', slug: 'fugue', name: 'Fugue' }).onConflictDoNothing().run();
	db.insert(mods).values({ source: 'curseforge', slug: '1005815', name: 'Fugue' }).onConflictDoNothing().run();
	for (const j of all) {
		const modId = db.select().from(mods).where(eq(mods.slug, j.source === 'curseforge' ? '1005815' : 'fugue')).get()!.id;
		db.insert(instanceMods)
			.values({ instanceId: instance.id, modId, filePath: `mods/${file(j)}`, version: j.version, versionId: `fugue-${j.version}`, enabled: j.enabled !== false, clientOnly: !!j.clientOnly, installedAt: 1 })
			.run();
		await fs.access(path.join(instance.path, 'mods', file(j)));
	}
	return instance;
}

describe('mod updates on Cleanroom', () => {
	it('offers the newest Fugue that runs on the installed Cleanroom, not the newest one', async () => {
		const check = await checkModUpdates(await server('0.5.17-alpha', '0.23.4'));
		expect(check.updates).toMatchObject([{ name: 'Fugue', currentVersion: '0.23.4', targetVersion: '0.23.7' }]);
	});

	it('counts a Fugue already the newest for its Cleanroom as up to date', async () => {
		const check = await checkModUpdates(await server('0.5.17-alpha', '0.23.7'));
		expect(check.updates).toEqual([]);
		expect(check.upToDate).toBe(1);
	});

	it('offers the newest Fugue to a server on the newest Cleanroom', async () => {
		const check = await checkModUpdates(await server('0.7.3-alpha', '0.24.4'));
		expect(check.updates).toMatchObject([{ targetVersion: '0.25.5' }]);
	});

	it('leaves out a disabled older copy of the Fugue in use, saying which one is', async () => {
		const check = await checkModUpdates(await server('0.5.17-alpha', '0.23.4', { version: '0.21.0', enabled: false }));
		expect(check.updates.map((u) => u.fileName)).toEqual(['+Fugue-0.23.4.jar']);
		expect(check.skipped).toEqual([{ fileName: '+Fugue-0.21.0.jar.disabled', name: 'Fugue', reason: 'Disabled; +Fugue-0.23.4.jar is the copy in use' }]);
	});

	it('tells the copies apart by mod id, so one from the other platform counts too', async () => {
		// MeatballCraft: the pack's old Fugue (CurseForge), disabled once Cleanroom's fixes added one from Modrinth.
		const check = await checkModUpdates(await server('0.5.17-alpha', '0.23.7', { version: '0.21.0', enabled: false, source: 'curseforge' }));
		expect(check.updates).toEqual([]);
		expect(check.skipped).toEqual([{ fileName: '+Fugue-0.21.0.jar.disabled', name: 'Fugue', reason: 'Disabled; +Fugue-0.23.7.jar is the copy in use' }]);
	});

	it('says why a disabled mod is off, where it is known', async () => {
		const check = await checkModUpdates(await server('0.5.17-alpha', { version: '0.23.4', enabled: false, clientOnly: true }));
		expect(check.updates).toMatchObject([{ enabled: false, disabledReason: 'client-only: does nothing on a dedicated server, or crashes it' }]);
	});
});
