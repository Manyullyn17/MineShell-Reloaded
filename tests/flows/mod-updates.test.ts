import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Updating mods and switching one mod's version (modupdates.ts), against a fake Modrinth. */

const { checkModUpdates, changeModVersions, listModVersions, pickUpdate } = await import('#lib/server/modupdates.js');
const { db } = await import('#lib/server/db/index.js');
const { instanceMods, mods } = await import('#lib/server/db/schema.js');
const { listSnapshots } = await import('#lib/server/snapshots.js');
const { createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { restartMineShell, runAndDieAtMove } = await import('../helpers/crash');
const { useRecordedHttp } = await import('../helpers/http');

const API = 'https://api.modrinth.com/v2';
const sha512 = (s: string) => crypto.createHash('sha512').update(s).digest('hex');

type V = { id: string; project: string; number: string; type: string; date: string; file: string; content: string; requires?: string[] };
const versions: V[] = [
	{ id: 'S1', project: 'sodium', number: '0.5.0', type: 'release', date: '2025-01-01', file: 'sodium-0.5.0.jar', content: 'sodium 0.5.0' },
	{ id: 'S2', project: 'sodium', number: '0.6.0', type: 'release', date: '2025-06-01', file: 'sodium-0.6.0.jar', content: 'sodium 0.6.0', requires: ['P_FAPI'] },
	{ id: 'S3', project: 'sodium', number: '0.7.0-beta', type: 'beta', date: '2025-09-01', file: 'sodium-0.7.0-beta.jar', content: 'sodium 0.7.0' },
	{ id: 'L1', project: 'lithium', number: '1.0', type: 'release', date: '2025-01-01', file: 'lithium-1.0.jar', content: 'lithium 1.0' },
	{ id: 'L2', project: 'lithium', number: '2.0', type: 'release', date: '2025-08-01', file: 'lithium-2.0.jar', content: 'lithium 2.0', requires: ['P_FAPI'] },
	{ id: 'F1', project: 'P_FAPI', number: '1.0', type: 'release', date: '2025-05-01', file: 'fabric-api-1.0.jar', content: 'fabric api 1.0' }
];

const project = (id: string, slug: string, title: string) => ({
	id,
	slug,
	title,
	description: '',
	icon_url: null,
	downloads: 1,
	loaders: ['fabric'],
	game_versions: ['1.21.1'],
	team: 't'
});

function mr(v: V) {
	return {
		id: v.id,
		project_id: v.project,
		name: v.number,
		version_number: v.number,
		version_type: v.type,
		date_published: `${v.date}T00:00:00Z`,
		game_versions: ['1.21.1'],
		loaders: ['fabric'],
		changelog: null,
		files: [{ filename: v.file, url: `https://cdn.example/${v.file}`, primary: true, size: v.content.length, hashes: { sha512: sha512(v.content) } }],
		dependencies: (v.requires ?? []).map((id) => ({ project_id: id, version_id: null, dependency_type: 'required', file_name: null }))
	};
}

const listUrl = (slug: string) =>
	`${API}/project/${slug}/version?${new URLSearchParams({ game_versions: JSON.stringify(['1.21.1']), loaders: JSON.stringify(['fabric']) })}`;

let failDownload: string | null = null;
const extra: Record<string, () => Response> = {
	// Newest per installed file, as Modrinth answers: sodium's newest is the beta.
	[`${API}/version_files/update`]: () =>
		Response.json({ [sha512('sodium 0.5.0')]: mr(versions[2]), [sha512('lithium 1.0')]: mr(versions[4]) }),
	[listUrl('sodium')]: () => Response.json(versions.filter((v) => v.project === 'sodium').reverse().map(mr)),
	[listUrl('lithium')]: () => Response.json(versions.filter((v) => v.project === 'lithium').reverse().map(mr)),
	[listUrl('P_FAPI')]: () => Response.json([mr(versions[5])]),
	[`${API}/project/P_FAPI`]: () => Response.json(project('P_FAPI', 'fabric-api', 'Fabric API')),
	// What Sync asks about jars it has no record of.
	[`${API}/version_files`]: () => Response.json({ [sha512('sodium 0.5.0')]: mr(versions[0]) }),
	[`${API}/projects?ids=${encodeURIComponent(JSON.stringify(['sodium']))}`]: () => Response.json([project('sodium', 'sodium', 'Sodium')])
};
for (const v of versions) {
	extra[`${API}/version/${v.id}`] = () => Response.json(mr(v));
	extra[`https://cdn.example/${v.file}`] = () =>
		failDownload === v.file ? new Response('gone', { status: 500 }) : new Response(v.content);
}
useRecordedHttp('mod-updates', { extra });

/** A Fabric server with sodium 0.5 (pack), lithium 1.0 (disabled, locked), and a manual jar. */
async function server() {
	const instance = await createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1', modloaderVersion: '0.16.5' },
		{
			'mods/sodium-0.5.0.jar': 'sodium 0.5.0',
			'mods/lithium-1.0.jar.disabled': 'lithium 1.0',
			'mods/mine.jar': 'my own jar',
			'world/level.dat': 'world'
		}
	);
	const modId = (slug: string) =>
		db.insert(mods).values({ source: 'modrinth', slug, name: slug === 'sodium' ? 'Sodium' : 'Lithium' }).onConflictDoNothing().run() &&
		db.select().from(mods).where(eq(mods.slug, slug)).get()!.id;
	const row = { instanceId: instance.id, installedAt: 1, hashAlgo: 'sha512' };
	db.insert(instanceMods)
		.values([
			{ ...row, modId: modId('sodium'), filePath: 'mods/sodium-0.5.0.jar', version: '0.5.0', versionId: 'S1', hash: sha512('sodium 0.5.0'), fromPack: true },
			{ ...row, modId: modId('lithium'), filePath: 'mods/lithium-1.0.jar.disabled', version: '1.0', versionId: 'L1', hash: sha512('lithium 1.0'), enabled: false, locked: true }
		])
		.run();
	return instance;
}

const rowsOf = (id: string) => db.select().from(instanceMods).where(eq(instanceMods.instanceId, id)).all();
const both = [
	{ fileName: 'sodium-0.5.0.jar', versionId: 'S2' },
	{ fileName: 'lithium-1.0.jar.disabled', versionId: 'L2' }
];

describe('mod updates', () => {
	beforeEach(() => {
		systemdStopped();
		failDownload = null;
	});
	afterEach(() => vi.restoreAllMocks());

	it('offers the newest release to a mod on a release, leaving locked and untracked ones out', async () => {
		const instance = await server();
		const check = await checkModUpdates(instance);
		expect(check.updates).toMatchObject([{ name: 'Sodium', currentVersion: '0.5.0', targetVersionId: 'S2', targetVersion: '0.6.0' }]);
		expect(check.dependencies).toMatchObject({ install: [{ name: 'Fabric API', versionNumber: '1.0', neededBy: ['Sodium'] }], unresolved: [] });
		expect(check.skipped.map((s) => [s.name, s.reason])).toEqual([
			['Lithium', 'Locked'],
			['mine', 'Not from Modrinth or CurseForge']
		]);
	});

	it('lists every compatible version, older ones too, with the installed one marked', async () => {
		const instance = await server();
		const { versions: list } = await listModVersions(instance, 'sodium-0.5.0.jar');
		expect(list.map((v) => [v.versionNumber, v.installed])).toEqual([
			['0.7.0-beta', false],
			['0.6.0', false],
			['0.5.0', true]
		]);
	});

	it('swaps the jars and keeps each mod disabled, locked or from the pack as it was', async () => {
		const instance = await server();
		expect((await waitForTask(await changeModVersions(instance, both, { snapshot: false, label: 'Updating 2 mods' }))).state).toBe('done');
		const files = await tree(instance.path);
		expect(files['mods/sodium-0.6.0.jar']).toBe('sodium 0.6.0');
		expect(files['mods/lithium-2.0.jar.disabled']).toBe('lithium 2.0');
		expect(files['mods/sodium-0.5.0.jar']).toBeUndefined();
		expect(files['mods/mine.jar']).toBe('my own jar');
		// Both new versions need Fabric API; it is installed once.
		expect(files['mods/fabric-api-1.0.jar']).toBe('fabric api 1.0');
		const rows = rowsOf(instance.id);
		expect(rows.find((r) => r.filePath === 'mods/fabric-api-1.0.jar')).toMatchObject({ version: '1.0', fromPack: false });
		expect(rows.find((r) => r.filePath === 'mods/sodium-0.6.0.jar')).toMatchObject({ version: '0.6.0', versionId: 'S2', fromPack: true });
		expect(rows.find((r) => r.filePath === 'mods/lithium-2.0.jar.disabled')).toMatchObject({ version: '2.0', enabled: false, locked: true });
		expect(rows).toHaveLength(3);
		expect(reload(instance.id)).toMatchObject({ status: 'ready', statusMessage: null });
	});

	it('goes back to an older version just the same', async () => {
		const instance = await server();
		await waitForTask(await changeModVersions(instance, [both[0]], { snapshot: false, label: 'x' }));
		await waitForTask(await changeModVersions(reload(instance.id), [{ fileName: 'sodium-0.6.0.jar', versionId: 'S1' }], { snapshot: false, label: 'x' }));
		expect((await tree(instance.path))['mods/sodium-0.5.0.jar']).toBe('sodium 0.5.0');
	});

	it('snapshots the world first when asked', async () => {
		const instance = await server();
		await waitForTask(await changeModVersions(instance, [both[0]], { snapshot: true, label: 'Switching Sodium' }));
		expect((await listSnapshots(instance.path)).map((s) => [s.reason, s.label])).toEqual([['mod-update', 'Before switching Sodium']]);
	});

	it('does not install a dependency already there from the other platform', async () => {
		const instance = await server();
		const cf = db.insert(mods).values({ source: 'curseforge', slug: '306612', name: 'Fabric API' }).returning().get();
		await fs.writeFile(path.join(instance.path, 'mods', 'fabric-api-cf.jar'), 'from curseforge');
		db.insert(instanceMods).values({ instanceId: instance.id, modId: cf.id, filePath: 'mods/fabric-api-cf.jar', installedAt: 1 }).run();
		await waitForTask(await changeModVersions(instance, [both[0]], { snapshot: false, label: 'x' }));
		expect((await tree(instance.path))['mods/fabric-api-1.0.jar']).toBeUndefined();
	});

	it('puts the mods back when a dependency cannot be downloaded', async () => {
		const instance = await server();
		const before = await tree(instance.path);
		const rowsBefore = rowsOf(instance.id);
		failDownload = 'fabric-api-1.0.jar';
		expect((await waitForTask(await changeModVersions(instance, both, { snapshot: false, label: 'x' }))).state).toBe('failed');
		expect(await tree(instance.path)).toEqual(before);
		expect(rowsOf(instance.id)).toEqual(rowsBefore);
	});

	it('syncs jars it has no record of before checking, so they can be updated too', async () => {
		const instance = await createInstance(
			{ modloader: 'fabric', minecraftVersion: '1.21.1' },
			{ 'mods/sodium-0.5.0.jar': 'sodium 0.5.0' }
		);
		const check = await checkModUpdates(instance);
		expect(check.synced).toBe('identified 1 mod');
		expect(check.updates).toMatchObject([{ name: 'Sodium', targetVersion: '0.6.0' }]);
	});

	it('puts every mod and record back when one download fails', async () => {
		const instance = await server();
		const before = await tree(instance.path);
		const rowsBefore = rowsOf(instance.id);
		failDownload = 'lithium-2.0.jar';
		const task = await waitForTask(await changeModVersions(instance, both, { snapshot: false, label: 'Updating 2 mods' }));
		expect(task.state).toBe('failed');
		expect(await tree(instance.path)).toEqual(before);
		expect(rowsOf(instance.id)).toEqual(rowsBefore);
		expect(reload(instance.id).statusMessage).toMatch(/mods were put back/);
	});

	it('puts them back wherever MineShell stopped', async () => {
		let stops = 0;
		for (let n = 1; ; n++) {
			const instance = await server();
			const before = await tree(instance.path);
			const rowsBefore = rowsOf(instance.id);
			const outcome = await runAndDieAtMove(instance.path, n, () =>
				changeModVersions(instance, both, { snapshot: false, label: 'Updating 2 mods' })
			);
			if (outcome === 'finished') break;
			stops++;
			await restartMineShell();
			expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before);
			expect(rowsOf(instance.id), `stopped at move ${n}`).toEqual(rowsBefore);
			vi.restoreAllMocks();
			systemdStopped();
		}
		// Per mod: staged, downloaded into place; lithium disabled again; Fabric API downloaded.
		expect(stops).toBe(6);
	});
});

describe('picking an update', () => {
	const v = (id: string, channel: string, date: string) =>
		({ id, versionNumber: id, channel, datePublished: date, files: [] }) as never;

	it('keeps a release on releases, lets a beta move to newer betas', () => {
		const list = [v('b2', 'beta', '2025-09-01'), v('r2', 'release', '2025-06-01'), v('r1', 'release', '2025-01-01')];
		expect(pickUpdate(list, { versionId: 'r1', version: 'r1' })).toMatchObject({ id: 'r2' });
		expect(pickUpdate([v('b2', 'beta', '2025-09-01'), v('r1', 'release', '2025-01-01')], { versionId: 'r1', version: 'r1' })).toBeNull();
		expect(pickUpdate([v('b3', 'beta', '2025-10-01'), v('b2', 'beta', '2025-09-01')], { versionId: 'b2', version: 'b2' })).toMatchObject({ id: 'b3' });
	});

	it('offers the best release when the installed version is not in the list', () => {
		const list = [v('r2', 'release', '2025-06-01')];
		expect(pickUpdate(list, { versionId: 'gone', version: '1.0' })).toMatchObject({ id: 'r2' });
		expect(pickUpdate(list, { versionId: null, version: 'r2' })).toBeNull();
	});
});
