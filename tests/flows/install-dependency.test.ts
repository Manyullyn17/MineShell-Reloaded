import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ModProvider, ProjectVersion } from '#lib/server/mods/index.js';

/**
 * A crash diagnosis' "Install" (moddeps.ts, installDependency): the mod a crashed server's
 * mod needs, by the id its loader named. Modrinth is a fake; the download and install are real.
 */
const PROJECTS: Record<string, { name: string; builds: Record<string, { version: string; requires?: string[] }> }> = {
	'fabric-api': { name: 'Fabric API', builds: { 'fabric 1.20.1': { version: '0.92.6', requires: ['fabric-lib'] } } },
	'fabric-lib': { name: 'Fabric Lib', builds: { 'fabric 1.20.1': { version: '1.0' } } },
	'old-only': { name: 'Old Only', builds: { 'fabric 1.16.5': { version: '2.0' } } }
};
const fakeModrinth: Partial<ModProvider> = {
	getProject: async (slug: string) => {
		const p = PROJECTS[slug];
		if (!p) throw new Error('404');
		return { source: 'modrinth', id: slug, slug, name: p.name, author: null, summary: null, iconUrl: null, downloads: 0, projectUrl: null, loaders: [], gameVersions: [] };
	},
	listVersions: async (slug: string, filter?: { minecraftVersion?: string; loader?: string }): Promise<ProjectVersion[]> => {
		const build = PROJECTS[slug]?.builds[`${filter?.loader} ${filter?.minecraftVersion}`];
		if (!build) return [];
		return [{
			id: `${slug}-${build.version}`, projectId: slug, name: build.version, versionNumber: build.version, channel: 'release',
			datePublished: '2026-01-01T00:00:00Z', gameVersions: [filter!.minecraftVersion!], loaders: [filter!.loader!], changelog: null,
			files: [{ filename: `${slug}-${build.version}.jar`, url: `https://mods.test/${slug}-${build.version}.jar`, primary: true, hash: null, size: null }],
			dependencies: (build.requires ?? []).map((projectId) => ({ projectId, versionId: null, name: PROJECTS[projectId].name, type: 'required' as const }))
		}];
	}
};
vi.mock('#lib/server/mods/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/mods/index.js')>();
	return { ...actual, getModProvider: (id: string) => (id === 'modrinth' ? (fakeModrinth as ModProvider) : actual.getModProvider(id)) };
});

const { installDependency, installingDependency } = await import('#lib/server/moddeps.js');
const { createInstance, waitForTask } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');

useRecordedHttp('none', {
	extra: {
		'https://mods.test/fabric-api-0.92.6.jar': () => new Response('fabric api'),
		'https://mods.test/fabric-lib-1.0.jar': () => new Response('fabric lib')
	}
});

describe('installing what a crashed mod needs', () => {
	// The diagnosis only offered to disable the mod (Chunky without Fabric API), and a restart
	// cannot bring a dependency.
	it('installs Fabric API for the id `fabric`, with what it needs in turn', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1' });
		const id = await installDependency(instance, 'fabric');
		// The banner says it is being installed instead of offering the buttons again.
		expect(installingDependency(instance.id, 'fabric')).toBe(true);
		const task = await waitForTask(id);
		expect(task.state).toBe('done');
		expect(installingDependency(instance.id, 'fabric')).toBe(false);
		expect((await fs.readdir(path.join(instance.path, 'mods'))).sort()).toEqual(['fabric-api-0.92.6.jar', 'fabric-lib-1.0.jar']);
	});

	it('says why when Modrinth has no such mod, or no build for this server', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1' });
		await expect(installDependency(instance, 'nosuchmod')).rejects.toThrow(/Modrinth has no mod "nosuchmod"/);
		await expect(installDependency(instance, 'old-only')).rejects.toThrow(/Old Only has no build for fabric 1.20.1/);
		await expect(installDependency(instance, '../etc')).rejects.toThrow(/not a mod id/);
	});
});
