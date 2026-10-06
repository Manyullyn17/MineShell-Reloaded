import { describe, expect, it } from 'vitest';
import { cleanroomDisabledReasons, cleanroomReport, isCleanroomRequiredJar } from './cleanroom';
import { mcmodInfo, tempDir, writeJar } from '../../../tests/helpers/fs';

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
