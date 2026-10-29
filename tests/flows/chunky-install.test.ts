import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * World > Pre-generate's "Install Chunky", and which servers are offered it.
 * Modrinth and the downloads are stand-ins; the jars they leave are read for
 * real, as that is how MineShell tells what is there.
 */

const FABRIC_API = 'P7dR8mSH';
const version = (projectId: string, versionNumber: string, dependencies: { projectId: string; type: string }[] = []) => ({
	id: `${projectId}-${versionNumber}`,
	projectId,
	name: `${projectId} ${versionNumber}`,
	versionNumber,
	channel: 'release',
	datePublished: '2026-10-01T00:00:00Z',
	gameVersions: ['1.21.1'],
	loaders: ['fabric'],
	changelog: null,
	files: [{ filename: `${projectId}.jar`, url: `https://cdn.test/${projectId}.jar`, primary: true }],
	dependencies: dependencies.map((d) => ({ ...d, versionId: null }))
});
const installed = vi.hoisted(() => [] as string[]);
const builds = vi.hoisted(() => ({ chunky: true }));

vi.mock('#lib/server/mods/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/mods/index.js')>();
	const { zipBuffer } = await import('../helpers/fs');
	return {
		...actual,
		getModProvider: () => ({
			id: 'modrinth',
			getProject: async (id: string) => ({ id, slug: id === FABRIC_API ? 'fabric-api' : id, name: id === FABRIC_API ? 'Fabric API' : id, projectUrl: null, iconUrl: null })
		}),
		// What a download leaves: a jar declaring the project's mod id.
		installModVersion: async (instance: { path: string }, _: unknown, project: { slug: string }) => {
			installed.push(project.slug);
			await fs.writeFile(path.join(instance.path, 'mods', `${project.slug}.jar`), zipBuffer({ 'fabric.mod.json': JSON.stringify({ id: project.slug }) }));
			return project.slug;
		}
	};
});
vi.mock('#lib/server/modupdates.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/modupdates.js')>()),
	compatibleVersions: async (_: string, projectId: string) =>
		projectId === 'chunky'
			? builds.chunky
				? [version('chunky', '1.4.23', [{ projectId: FABRIC_API, type: 'required' }])]
				: []
			: [version(projectId, '0.116.17')]
}));

const { chunkyUnsupported, ChunkyError, hasChunky, installChunky } = await import('#lib/server/chunky.js');
const { createInstance, waitForTask } = await import('../helpers/instances');

describe('which servers can have Chunky', () => {
	it('starts at 1.16 on Fabric and 1.16.5 on Forge', () => {
		expect(chunkyUnsupported({ modloader: 'fabric', minecraftVersion: '1.16' })).toBeNull();
		expect(chunkyUnsupported({ modloader: 'quilt', minecraftVersion: '1.20.1' })).toBeNull();
		expect(chunkyUnsupported({ modloader: 'forge', minecraftVersion: '1.16.5' })).toBeNull();
		expect(chunkyUnsupported({ modloader: 'neoforge', minecraftVersion: '1.21.1' })).toBeNull();
		expect(chunkyUnsupported({ modloader: 'forge', minecraftVersion: '1.16.4' })).toMatch(/no build for Forge 1\.16\.4/);
		expect(chunkyUnsupported({ modloader: 'fabric', minecraftVersion: '1.15.2' })).toMatch(/no build for Fabric 1\.15\.2/);
	});

	it('has none for 1.12.2, Cleanroom or a vanilla server', () => {
		expect(chunkyUnsupported({ modloader: 'forge', minecraftVersion: '1.12.2' })).toMatch(/no build for Forge 1\.12\.2/);
		expect(chunkyUnsupported({ modloader: 'cleanroom', minecraftVersion: '1.12.2' })).toMatch(/no build for Cleanroom/);
		expect(chunkyUnsupported({ modloader: 'vanilla', minecraftVersion: '1.21.1' })).toMatch(/cannot load mods/);
	});
});

describe('installing Chunky', () => {
	it('adds it, with Fabric API on a server that has none', async () => {
		installed.length = 0;
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'mods/.keep': '' });
		const task = await waitForTask(await installChunky(instance));
		expect(task.state).toBe('done');
		expect(installed).toEqual(['chunky', 'fabric-api']);
		expect(await hasChunky(instance.path)).toBe(true);
	});

	it('refuses where there is no build, before starting anything', async () => {
		installed.length = 0;
		const instance = await createInstance({ modloader: 'forge', minecraftVersion: '1.12.2' }, { 'mods/.keep': '' });
		await expect(installChunky(instance)).rejects.toThrow(ChunkyError);
		expect(installed).toEqual([]);
	});

	it('fails the task when the catalog has no build for the exact version', async () => {
		installed.length = 0;
		builds.chunky = false;
		try {
			const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'mods/.keep': '' });
			const task = await waitForTask(await installChunky(instance));
			expect(task.state).toBe('failed');
			expect(task.log.join('\n')).toMatch(/Chunky has no build for Fabric 1\.21\.1/);
			expect(installed).toEqual([]);
		} finally {
			builds.chunky = true;
		}
	});

	it('refuses when it is there already', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'mods/.keep': '' });
		await waitForTask(await installChunky(instance));
		await expect(installChunky(instance)).rejects.toThrow(/installed already/);
	});
});
