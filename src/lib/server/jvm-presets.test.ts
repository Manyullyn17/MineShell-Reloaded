import { describe, expect, it } from 'vitest';
import { composeJvmArgs, stripJava8OnlyFlags, stripMemoryFlags } from './jvm-presets';

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
