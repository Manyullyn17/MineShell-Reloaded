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

/** A Cleanroom server with Fugue `installed`, tracked as Modrinth's. */
async function server(cleanroom: string, installed: string) {
	const file = `+Fugue-${installed}.jar`;
	const instance = await createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: cleanroom }, { [`mods/${file}`]: `fugue ${installed}` });
	db.insert(mods).values({ source: 'modrinth', slug: 'fugue', name: 'Fugue' }).onConflictDoNothing().run();
	const modId = db.select().from(mods).where(eq(mods.slug, 'fugue')).get()!.id;
	db.insert(instanceMods)
		.values({ instanceId: instance.id, modId, filePath: `mods/${file}`, version: installed, versionId: `fugue-${installed}`, installedAt: 1 })
		.run();
	await fs.access(path.join(instance.path, 'mods', file));
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
});
