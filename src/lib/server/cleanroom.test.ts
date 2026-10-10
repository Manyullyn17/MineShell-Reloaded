import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
	cleanroomDisabledReasons,
	cleanroomHasGetUrl,
	cleanroomReport,
	inspectFugueJar,
	inVersionRange,
	isCleanroomRequiredJar,
	pickFugue
} from './cleanroom';
import type { ProjectVersion } from './mods';
import { mcmodInfo, tempDir, writeJar, zipBuffer } from '../../../tests/helpers/fs';

async function report(jars: Record<string, Record<string, string>>) {
	const dir = await tempDir();
	for (const [name, files] of Object.entries(jars)) await writeJar(`${dir}/mods`, name, files);
	return cleanroomReport(dir);
}

describe('cleanroomReport', () => {
	it('flags must-remove mods by modid, mcmod.info name or filename', async () => {
		const r = await report({
			'[___MixinCompat-0.8___].jar': { 'mcmod.info': mcmodInfo('mixincompat', 'Mixin Compatibility') },
			// Ships modid "vintagium" (the real Vintagium's) - only its name gives it away.
			'relictium-1.2.0.jar': { 'mcmod.info': mcmodInfo('vintagium', 'Relictium') },
			// Coremod with no mcmod.info at all.
			'_MixinBootstrap-1.1.0.jar': { 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0' },
			'UniversalTweaks-1.12.2.jar': { 'mcmod.info': mcmodInfo('universaltweaks', 'Universal Tweaks') }
		});
		expect(r.disable.map((d) => d.label).sort()).toEqual(['Mixin 0.7-0.8 Compatibility', 'MixinBootstrap', 'Relictium']);
		expect(r.advise).toEqual([]);
	});

	it('does not flag forks that kept the original modid', async () => {
		const r = await report({
			'jei.jar': { 'mcmod.info': mcmodInfo('jei', 'Just Enough Items') },
			'hei.jar': { 'mcmod.info': mcmodInfo('jei', 'Had Enough Items') }
		});
		expect(r.advise.map((a) => a.fileName)).toEqual(['jei.jar']);
	});

	it('detects Fugue and Scalar Legacy as present', async () => {
		const before = await report({});
		expect(before.required.every((m) => !m.present)).toBe(true);
		const after = await report({
			'+Fugue-0.23.3.jar': { 'mcmod.info': mcmodInfo('fugue', 'Fugue') },
			'Scalar Legacy-1.0.1.jar': { 'mcmod.info': mcmodInfo('scalar', 'Scalar Legacy') }
		});
		expect(after.required.every((m) => m.present)).toBe(true);
	});

	it('ignores disabled jars', async () => {
		const r = await report({ 'normalasm-5.6.jar.disabled': { 'mcmod.info': mcmodInfo('normalasm', 'NormalASM') } });
		expect(r.disable).toEqual([]);
	});
});

describe('isCleanroomRequiredJar', () => {
	it('recognises the jars MineShell manages itself', () => {
		expect(isCleanroomRequiredJar('+Fugue-0.24.4.jar')).toBe(true);
		expect(isCleanroomRequiredJar('scalar-1.12.2-2.11.1.jar')).toBe(true);
		expect(isCleanroomRequiredJar('jei.jar')).toBe(false);
	});
});

async function modsDir(jars: Record<string, Record<string, string>>) {
	const dir = await tempDir();
	for (const [name, files] of Object.entries(jars)) await writeJar(`${dir}/mods`, name, files);
	return dir;
}

describe('cleanroomDisabledReasons', () => {
	it('names disabled jars the must-remove list covers, by file, and nothing else', async () => {
		const dir = await modsDir({
			'MixinBootstrap-1.1.0.jar.disabled': {},
			'SerializationIsBad-1.5.2.jar.disabled': { 'mcmod.info': mcmodInfo('serializationisbad', 'SerializationIsBad') },
			'SmoothFont-mc1.12.2-2.1.4.jar': { 'mcmod.info': mcmodInfo('smoothfont', 'Smooth Font') },
			'jei_1.12.2-4.16.jar.disabled': { 'mcmod.info': mcmodInfo('jei', 'Just Enough Items') }
		});
		const reasons = await cleanroomDisabledReasons(dir);
		expect(Object.keys(reasons).sort()).toEqual(['MixinBootstrap-1.1.0.jar.disabled', 'SerializationIsBad-1.5.2.jar.disabled']);
		expect(reasons['SerializationIsBad-1.5.2.jar.disabled']).toBe('SerializationIsBad: Redundant on modern Java.');
	});
});

const HACKERY = 'com/cleanroommc/hackery/ReflectionHackery';

/** A Fugue jar with what inspectFugueJar reads: the declared range and, for <= 0.23.2, the getURL rewrite. */
function fugueJar(range: string, callsGetUrl: boolean): Record<string, string> {
	return {
		'mcmod.info': mcmodInfo('fugue', 'Fugue'),
		'com/cleanroommc/fugue/Fugue.class': `\u0000required-after:cleanroom@${range};\u0000`,
		'com/cleanroommc/fugue/transformer/universal/URLClassLoaderTransformer.class': callsGetUrl
			? `\u0000getURLs\u0000${HACKERY}\u0000getURL\u0000`
			: '\u0000getURLs\u0000com/cleanroommc/fugue/helper/HookHelper\u0000getURL\u0000',
		// Newer Fugue still uses ReflectionHackery's field helpers: not the getURL problem.
		'com/cleanroommc/fugue/transformer/universal/ReflectFieldTransformer.class': `\u0000${HACKERY}\u0000setField\u0000`
	};
}

/** Cleanroom's own jar, with or without ReflectionHackery.getURL (removed in 0.5.3). */
function cleanroomJar(withGetUrl: boolean): Buffer {
	return zipBuffer({ [`${HACKERY}.class`]: withGetUrl ? '\u0000getURL\u0000setField\u0000' : '\u0000setField\u0000' });
}

describe('Fugue against the Cleanroom version', () => {
	it('reads version ranges the way Forge does', () => {
		expect(inVersionRange('0.5.17-alpha', '[0.5.14-alpha,)')).toBe(true);
		expect(inVersionRange('0.5.14-alpha', '[0.5.14-alpha,)')).toBe(true);
		expect(inVersionRange('0.5.14-alpha', '(0.5.14-alpha,)')).toBe(false);
		expect(inVersionRange('0.5.17-alpha', '[0.6.10-alpha,)')).toBe(false);
		expect(inVersionRange('0.6.0-alpha', '[0.5.0,0.6.0)')).toBe(false);
		expect(inVersionRange('0.6.0-alpha', '[0.5.0,0.6.0]')).toBe(true);
		expect(inVersionRange('0.5.17-alpha', 'whatever')).toBe(true);
	});

	it('flags a Fugue that rewrites mods to call a getURL this Cleanroom no longer has', async () => {
		// MeatballCraft 0.18.4-hotfix6 ships Fugue 0.21.0; on Cleanroom 0.5.17 Quantum
		// Things' coremod died with NoSuchMethodError ReflectionHackery.getURL.
		const dir = await tempDir();
		await writeJar(`${dir}/mods`, '+Fugue-0.21.0.jar', fugueJar('[0.3.20-alpha,)', true));
		await writeJar(`${dir}/mods`, 'Scalar Legacy-1.0.1.jar', { 'mcmod.info': mcmodInfo('scalar', 'Scalar Legacy') });
		await fs.writeFile(`${dir}/cleanroom-0.5.17-alpha.jar`, cleanroomJar(false));
		await fs.writeFile(`${dir}/cleanroom-0.5.2-alpha.jar`, cleanroomJar(true));

		const r = await cleanroomReport(dir, '0.5.17-alpha');
		expect(r.replace).toEqual([expect.objectContaining({ fileName: '+Fugue-0.21.0.jar', label: 'Fugue', reason: expect.stringMatching(/getURL/) })]);
		expect(r.required.find((m) => m.label === 'Fugue')?.present).toBe(false);
		expect(r.required.find((m) => m.label === 'Scalar Legacy')?.present).toBe(true);
		expect((await cleanroomReport(dir, '0.5.2-alpha')).replace).toEqual([]);
		// No Cleanroom version (not on Cleanroom yet): nothing to check against.
		expect((await cleanroomReport(dir)).replace).toEqual([]);
	});

	it('flags a Fugue whose declared range leaves this Cleanroom out', async () => {
		const dir = await tempDir();
		await writeJar(`${dir}/mods`, '+Fugue-0.24.4.jar', fugueJar('[0.6.10-alpha,)', false));
		const r = await cleanroomReport(dir, '0.5.17-alpha');
		expect(r.replace.map((x) => x.reason)).toEqual(['It needs Cleanroom [0.6.10-alpha,).']);
		expect((await cleanroomReport(dir, '0.6.13-alpha')).replace).toEqual([]);
	});

	it('goes by the version getURL was removed in when the Cleanroom jar is not there', async () => {
		const dir = await tempDir();
		expect(await cleanroomHasGetUrl(dir, '0.5.2-alpha')).toBe(true);
		expect(await cleanroomHasGetUrl(dir, '0.5.3-alpha')).toBe(false);
	});

	it('inspects the jars it reads', async () => {
		const dir = await tempDir();
		const file = await writeJar(dir, 'f.jar', fugueJar('[0.5.7-alpha,)', false));
		expect(await inspectFugueJar(file)).toEqual({ range: '[0.5.7-alpha,)', callsGetUrl: false });
	});
});

/** Fugue's releases as measured from the jars (2026-10-11): declared range, getURL rewrite. */
const FUGUE_RELEASES: [string, string, string, boolean][] = [
	['0.24.4', '2026-09-14', '[0.6.10-alpha,)', false],
	['0.23.7', '2026-07-10', '[0.5.14-alpha,)', false],
	['0.23.4', '2026-04-01', '[0.5.7-alpha,)', false],
	['0.23.3', '2026-03-15', '[0.4.4-alpha,)', false],
	['0.23.2', '2026-03-11', '[0.4.4-alpha,)', true],
	['0.21.0', '2025-10-11', '[0.3.20-alpha,)', true]
];

function fugueVersion(versionNumber: string, datePublished: string): ProjectVersion {
	return {
		id: `fugue-${versionNumber}`,
		projectId: 'fugue',
		name: versionNumber,
		versionNumber,
		channel: 'release',
		datePublished,
		gameVersions: ['1.12.2'],
		loaders: ['forge'],
		changelog: null,
		files: [{ url: `https://cdn.modrinth.com/fugue/+Fugue-${versionNumber}.jar`, filename: `+Fugue-${versionNumber}.jar`, primary: true, hash: null, size: null }],
		dependencies: []
	};
}

describe('pickFugue', () => {
	const versions = FUGUE_RELEASES.map(([v, date]) => fugueVersion(v, date));
	const info = async (v: ProjectVersion) => {
		const [, , range, callsGetUrl] = FUGUE_RELEASES.find(([n]) => n === v.versionNumber)!;
		return { range, callsGetUrl };
	};
	const pick = async (cleanroom: string, hasGetUrl: boolean) => (await pickFugue(versions, cleanroom, hasGetUrl, info))?.versionNumber;

	it('picks the newest build whose jar accepts this Cleanroom', async () => {
		// The newest (0.24.4) needs 0.6.10: taking it unchecked broke every 0.5.x server.
		expect(await pick('0.5.17-alpha', false)).toBe('0.23.7');
		expect(await pick('0.5.10-alpha', false)).toBe('0.23.4');
		expect(await pick('0.6.13-alpha', false)).toBe('0.24.4');
	});

	it('skips builds calling getURL on a Cleanroom without it', async () => {
		// 0.5.3-0.5.6: 0.23.4+ need 0.5.7, 0.23.2 and older call the removed getURL.
		expect(await pick('0.5.5-alpha', false)).toBe('0.23.3');
	});

	it('keeps Java 21 Cleanroom on Java 21 builds', async () => {
		expect(await pick('0.4.4-alpha', true)).toBe('0.23.3');
		expect(await pick('0.4.3-alpha', true)).toBe('0.21.0');
	});
});
