import { describe, expect, it } from 'vitest';
import { PRESET_DESCRIPTION_MAX, PRESET_NAME_MAX, composeJvmArgs, getPreset, presetFlags, presetRunsOn, saveCustomPreset, stripJava8OnlyFlags, stripMemoryFlags, updateCustomPreset } from './jvm-presets';

describe('stripJava8OnlyFlags', () => {
	it('removes flags that stop a modern JVM from starting', () => {
		const { flags, removed } = stripJava8OnlyFlags(
			'-Xmx4G -XX:+UseConcMarkSweepGC -XX:+CMSIncrementalMode -XX:+UseParNewGC -XX:MaxPermSize=256M -XX:+AggressiveOpts -XX:+UseG1GC'
		);
		expect(flags).toBe('-Xmx4G -XX:+UseG1GC');
		expect(removed).toEqual([
			'-XX:+UseConcMarkSweepGC',
			'-XX:+CMSIncrementalMode',
			'-XX:+UseParNewGC',
			'-XX:MaxPermSize=256M',
			'-XX:+AggressiveOpts'
		]);
	});

	it('leaves modern flags alone', () => {
		const aikar = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200';
		expect(stripJava8OnlyFlags(aikar)).toEqual({ flags: aikar, removed: [] });
	});
});

describe('memory flags', () => {
	it('are always rebuilt from the memory fields', () => {
		expect(stripMemoryFlags('-Xms1G -Xmx8G -XX:+UseG1GC')).toBe('-XX:+UseG1GC');
		expect(composeJvmArgs('-Xmx99G -XX:+UseG1GC', 1024, 4096)).toBe('-Xms1024M -Xmx4096M -XX:+UseG1GC');
	});
});

describe('the ZGC preset', () => {
	// Measured with OpenJDK 8, 17, 21 and 25: 17 refuses -XX:+ZGenerational
	// (unknown option), 24 and newer ignore it with a warning, 8 has no ZGC.
	const zgc = getPreset('zgc')!;

	it('adds -XX:+ZGenerational only on Java 21 to 23', () => {
		expect(presetFlags(zgc, 17)).not.toContain('ZGenerational');
		expect(presetFlags(zgc, 21)).toContain('-XX:+ZGenerational');
		expect(presetFlags(zgc, 23)).toContain('-XX:+ZGenerational');
		expect(presetFlags(zgc, 25)).not.toContain('ZGenerational');
		expect(presetFlags(zgc, null)).toBe('-XX:+UseZGC -XX:+AlwaysPreTouch -XX:+DisableExplicitGC -XX:+PerfDisableSharedMem');
	});

	it('does not run on Java 8 or 11', () => {
		expect(presetRunsOn(zgc, 8)).toBe(false);
		expect(presetRunsOn(zgc, 11)).toBe(false);
		expect(presetRunsOn(zgc, 17)).toBe(true);
		expect(presetRunsOn(zgc, null)).toBe(true);
		expect(presetRunsOn(getPreset('aikar')!, 8)).toBe(true);
	});
});

// A preset's name and description had no limit; both show in every server's preset picker.
describe('a saved preset', () => {
	it('takes a name and description at their limits', () => {
		const preset = saveCustomPreset('N'.repeat(PRESET_NAME_MAX), '-XX:+UseZGC', 'D'.repeat(PRESET_DESCRIPTION_MAX));
		expect(preset.name).toHaveLength(PRESET_NAME_MAX);
		expect(updateCustomPreset(preset.id, { name: preset.name, description: 'd'.repeat(PRESET_DESCRIPTION_MAX), flags: '' }).description).toHaveLength(PRESET_DESCRIPTION_MAX);
	});

	it('refuses a longer name or description', () => {
		expect(() => saveCustomPreset('N'.repeat(PRESET_NAME_MAX + 1), '')).toThrow(/at most/);
		expect(() => saveCustomPreset('Lean', '', 'D'.repeat(PRESET_DESCRIPTION_MAX + 1))).toThrow(/at most/);
		const preset = saveCustomPreset('Lean', '');
		expect(() => updateCustomPreset(preset.id, { name: 'N'.repeat(PRESET_NAME_MAX + 1), description: '', flags: '' })).toThrow(/at most/);
	});
});
