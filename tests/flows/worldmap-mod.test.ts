import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The Map tab's "Add the BlueMap mod" on a server without a pack: the mod
 * needs Fabric API, which a pack usually brings and a bare server lacks.
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
		projectId === 'bluemap' ? [version('bluemap', '5.7', [{ projectId: FABRIC_API, type: 'required' }, { projectId: 'optional-thing', type: 'optional' }])] : [version(projectId, '0.116.17')]
}));

const { installMapMod } = await import('#lib/server/worldmap.js');
const { createInstance, waitForTask } = await import('../helpers/instances');
const { zipBuffer } = await import('../helpers/fs');

describe('adding the BlueMap mod', () => {
	it('adds Fabric API with it on a server that has none', async () => {
		installed.length = 0;
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'mods/.keep': '' });
		const task = await waitForTask(await installMapMod(instance));
		expect(task.state).toBe('done');
		expect(installed).toEqual(['bluemap', 'fabric-api']);
		expect(task.log.join('\n')).toMatch(/Installed Fabric API 0\.116\.17, which it needs/);
	});

	it('leaves Fabric API alone when the server has it, from a pack or by hand', async () => {
		installed.length = 0;
		const instance = await createInstance(
			{ modloader: 'fabric', minecraftVersion: '1.21.1' },
			{ 'mods/fabric-api-0.116.jar': zipBuffer({ 'fabric.mod.json': JSON.stringify({ id: 'fabric-api' }) }) }
		);
		expect((await waitForTask(await installMapMod(instance))).state).toBe('done');
		expect(installed).toEqual(['bluemap']);
	});
});
