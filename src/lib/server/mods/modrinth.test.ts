import { describe, expect, it } from 'vitest';
import { modrinthProvider, versionsFromHashes } from './modrinth';
import { compareVersions } from '../java';
import { FUGUE_JAVA25_FROM, pickVersionForJava } from '../cleanroom';
import { isDatapackVersion } from './datapacks';
import { fetchCalls, useRecordedHttp } from '../../../../tests/helpers/http';

useRecordedHttp('modrinth');

const lastUrl = () => new URL(fetchCalls[fetchCalls.length - 1].url);

describe('modrinth search', () => {
	it('sends loader, version and environment filters as facets', async () => {
		const hits = await modrinthProvider.search({
			kind: 'mod',
			term: 'chunky',
			loaders: ['fabric'],
			minecraftVersions: ['1.21.1']
		});
		const facets: string[][] = JSON.parse(lastUrl().searchParams.get('facets')!);
		expect(facets).toContainEqual(['versions:1.21.1']);
		// A loader filter must not hide datapacks, which have no loader.
		expect(facets).toContainEqual(['categories:fabric', 'categories:datapack']);
		const env = facets.find((g) => g.some((f) => f.startsWith('environment:')))!;
		expect(env).not.toContain('environment:client_only');
		expect(hits.some((h) => h.slug === 'chunky')).toBe(true);
		expect(hits[0]).toMatchObject({ source: 'modrinth', loaders: [] });
	});
});

describe('modrinth projects and versions', () => {
	it('maps a project', async () => {
		const project = await modrinthProvider.getProject('fugue');
		expect(project).toMatchObject({ source: 'modrinth', slug: 'fugue', projectUrl: 'https://modrinth.com/project/fugue' });
		expect(project.loaders).toContain('forge');
		expect(project.gameVersions).toContain('1.12.2');
	});

	it('filters versions by Minecraft version and loader, preferring sha512', async () => {
		const versions = await modrinthProvider.listVersions('fugue', { minecraftVersion: '1.12.2', loader: 'forge' });
		const params = lastUrl().searchParams;
		expect(JSON.parse(params.get('game_versions')!)).toEqual(['1.12.2']);
		expect(JSON.parse(params.get('loaders')!)).toEqual(['forge']);
		expect(versions.length).toBeGreaterThan(10);
		const file = versions[0].files.find((f) => f.primary)!;
		expect(file.hash?.algo).toBe('sha512');
		expect(file.filename).toMatch(/fugue/i);
	});

	it('lists data pack releases next to the loader\'s when asked, and tells them apart', async () => {
		// Terralith publishes its data pack (.zip, loader "datapack") and its mod (.jar) as separate versions.
		const versions = await modrinthProvider.listVersions('terralith', {
			minecraftVersion: '1.21.1',
			loader: 'fabric',
			includeDatapacks: true
		});
		expect(JSON.parse(lastUrl().searchParams.get('loaders')!)).toEqual(['fabric', 'datapack']);
		const pack = versions.find((v) => v.loaders.includes('datapack') && !v.loaders.includes('fabric'))!;
		const jar = versions.find((v) => v.loaders.includes('fabric'))!;
		expect(pack.files[0].filename).toMatch(/\.zip$/);
		expect(isDatapackVersion(pack, 'fabric')).toBe(true);
		expect(isDatapackVersion(jar, 'fabric')).toBe(false);
		expect(isDatapackVersion(jar, 'vanilla')).toBe(jar.loaders.includes('datapack'));
		expect(isDatapackVersion(pack, 'quilt')).toBe(true);
	});

	it('picks a Fugue a Java 21 Cleanroom can load', async () => {
		// The boot crash this guards against: Fugue 0.24 (Java 25) on Cleanroom 0.4.4.
		const versions = await modrinthProvider.listVersions('fugue', { minecraftVersion: '1.12.2', loader: 'forge' });
		const forJava21 = pickVersionForJava(versions, FUGUE_JAVA25_FROM, 21)!;
		const forJava25 = pickVersionForJava(versions, FUGUE_JAVA25_FROM, 25)!;
		expect(compareVersions(forJava21.versionNumber, FUGUE_JAVA25_FROM)).toBeLessThan(0);
		expect(compareVersions(forJava25.versionNumber, FUGUE_JAVA25_FROM)).toBeGreaterThanOrEqual(0);
		const newestJava21 = versions
			.map((v) => v.versionNumber)
			.filter((n) => compareVersions(n, FUGUE_JAVA25_FROM) < 0)
			.sort(compareVersions)
			.pop();
		expect(forJava21.versionNumber).toBe(newestJava21);
	});

	it('identifies files by hash in one request', async () => {
		const versions = await modrinthProvider.listVersions('fugue', { minecraftVersion: '1.12.2', loader: 'forge' });
		const hash = versions[0].files.find((f) => f.primary)!.hash!.value;
		const found = await versionsFromHashes([hash, '0'.repeat(128)]);
		expect(fetchCalls[fetchCalls.length - 1]).toMatchObject({ method: 'POST' });
		expect(found.get(hash)?.id).toBe(versions[0].id);
		expect(found.has('0'.repeat(128))).toBe(false);
	});
});
