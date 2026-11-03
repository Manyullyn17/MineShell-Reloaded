import { describe, expect, it, vi } from 'vitest';
import { useRecordedHttp } from '../../../../tests/helpers/http';

/**
 * CurseForge's fingerprint and its lookup. The algorithm was checked on 2026-11-03 against the
 * `fileFingerprint` CurseForge lists for four jars of the user's MeatballCraft copy (all four
 * matched); the lookup's answers were recorded then with the dev MineShell's key
 * (tests/tools/curseforge-key.mjs, as curseforge-official-api.test.ts).
 */
const recording = process.env.RECORD_HTTP === '1';
const KEY = process.env.CURSEFORGE_API_KEY;

vi.mock('../curseforge', async (importOriginal) => ({
	...(await importOriginal<typeof import('../curseforge')>()),
	getCurseforgeApiKey: () => process.env.CURSEFORGE_API_KEY || 'replayed',
	curseforgeKeyConfigured: () => true,
	curseforgeKeyValid: () => true,
	markCurseforgeKeyInvalid: () => {
		throw new Error('CurseForge rejected the key');
	}
}));

const { curseforgeFingerprint } = await import('./fingerprint');
const official = await import('./curseforge-official');
const { identifyByFingerprint } = await import('./curseforge');

useRecordedHttp('curseforge-fingerprint');

describe("CurseForge's fingerprint", () => {
	it('leaves out tabs, line feeds, carriage returns and spaces', () => {
		const text = (s: string) => new TextEncoder().encode(s);
		expect(curseforgeFingerprint(text('a b\tc\r\nd'))).toBe(curseforgeFingerprint(text('abcd')));
		expect(curseforgeFingerprint(text('abcd'))).not.toBe(curseforgeFingerprint(text('abce')));
	});

	it('hashes every tail length the same way as the jars checked against CurseForge', () => {
		// Pinned from the implementation that matched CurseForge's own fingerprints.
		const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
		expect([0, 1, 2, 3, 4, 5, 6, 7, 64].map((n) => curseforgeFingerprint(bytes(n)))).toMatchInlineSnapshot(`
			[
			  1540447798,
			  2005651181,
			  2402533024,
			  398892657,
			  171461729,
			  2451350181,
			  2933346513,
			  160344728,
			  3429614881,
			]
		`);
	});
});

// MixinBootstrap 1.1.0 and Red Core 0.7, two of the four jars checked; 12345 matches nothing.
const MIXINBOOTSTRAP = 2764134718;
const RED_CORE = 3937023730;

describe.skipIf(recording && !KEY)('the fingerprint lookup', () => {
	it('finds the project and file of each jar CurseForge has, and leaves out the rest', async () => {
		const files = await official.filesByFingerprints([MIXINBOOTSTRAP, RED_CORE, 12345]);
		expect([...files.entries()].sort()).toEqual([
			[MIXINBOOTSTRAP, { projectId: '357178', fileId: '3437402', version: 'MixinBootstrap-1.1.0.jar' }],
			[RED_CORE, { projectId: '873867', fileId: '7394157', version: expect.any(String) }]
		]);
	});

	it('names the projects found, stored by their numeric id as every CurseForge mod is', async () => {
		const found = await identifyByFingerprint([MIXINBOOTSTRAP, 12345]);
		expect([...found.keys()]).toEqual([MIXINBOOTSTRAP]);
		expect(found.get(MIXINBOOTSTRAP)).toMatchObject({
			projectId: '357178',
			fileId: '3437402',
			project: { source: 'curseforge', id: '357178', slug: '357178', name: 'MixinBootstrap', iconUrl: expect.any(String) }
		});
	});
});
