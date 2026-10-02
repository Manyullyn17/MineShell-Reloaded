import { describe, expect, it, vi } from 'vitest';
import type { ProjectVersion } from './types';
import { useRecordedHttp } from '../../../../tests/helpers/http';

// Pretend a working CurseForge API key is configured, and stand in for the
// official API: its file tags are unordered ("1.12" before "1.12.2") and carry
// no loader build. That is the shape that installed MeatballCraft on Forge 1.12.
vi.mock('../curseforge', () => ({
	curseforgeKeyConfigured: () => true,
	curseforgeKeyValid: () => true,
	markCurseforgeKeyInvalid: () => undefined
}));
vi.mock('./curseforge-official', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./curseforge-official')>();
	return {
		...actual,
		getVersion: async (projectId: string, versionId: string): Promise<ProjectVersion> => ({
			id: versionId,
			projectId,
			name: 'Meatballcraft-prerelease-0.18.6.4.zip',
			versionNumber: 'Meatballcraft-prerelease-0.18.6.4.zip',
			channel: 'beta',
			datePublished: '2026-08-16T00:00:00Z',
			gameVersions: ['1.12', '1.12.2'],
			loaders: ['forge'],
			changelog: 'official changelog',
			files: [],
			dependencies: []
		})
	};
});

const { curseforgeProvider } = await import('./curseforge');

useRecordedHttp('curseforge');

describe('CurseForge provider with an API key', () => {
	it("keeps the mirror's exact install target when merging official metadata", async () => {
		const v = await curseforgeProvider.getVersion('411966', '8665629');
		expect(v.changelog).toBe('official changelog');
		expect(v.gameVersions).toEqual(['1.12.2']);
		expect(v.loaderVersions).toEqual({ forge: '14.23.5.2860' });
		expect(v.files.length).toBeGreaterThan(300);
	});
});
