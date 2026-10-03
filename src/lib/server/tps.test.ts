import { describe, expect, it } from 'vitest';
import { parseTickOutput, tickCommands } from './tps';

describe('parseTickOutput', () => {
	it('reads Forge 1.12', () => {
		const out = 'Dim  0 : Mean tick time: 0.402 ms. Mean TPS: 20.000\nOverall : Mean tick time: 0.853 ms. Mean TPS: 20.000';
		expect(parseTickOutput(out)).toEqual({ mspt: 0.853, tps: 20 });
	});

	it('reads modern Forge, including a comma-decimal locale', () => {
		expect(parseTickOutput('Overall: Mean tick time: 61,250 ms. Mean TPS: 16,327')).toEqual({ mspt: 61.25, tps: 16.327 });
	});

	it('reads NeoForge', () => {
		expect(parseTickOutput('minecraft:overworld: 20.000 TPS (1.100 ms/tick)\nOverall: 20.000 TPS (1.234 ms/tick)')).toEqual({ tps: 20, mspt: 1.234 });
	});

	it('reads vanilla tick query (recorded from a 1.21.1 server), capping TPS at the target', () => {
		const out =
			'The game is running normallyTarget tick rate: 20.0 per second.\nAverage time per tick: 0.3ms (Target: 50.0ms)Percentiles: P50: 0.2ms P95: 0.8ms P99: 4.7ms, sample: 100';
		expect(parseTickOutput(out)).toEqual({ mspt: 0.3, tps: 20 });
		expect(parseTickOutput('Target tick rate: 20.0 per second.\nAverage time per tick: 80.0ms (Target: 50.0ms)')).toEqual({ mspt: 80, tps: 12.5 });
	});

	it('gives up on anything else', () => {
		expect(parseTickOutput('Unknown or incomplete command')).toBeNull();
		expect(parseTickOutput('commands.forge.tps.summary.all')).toBeNull();
	});
});

describe('tickCommands', () => {
	it('asks the loader first, and tick query where vanilla has it', () => {
		expect(tickCommands({ modloader: 'forge', minecraftVersion: '1.12.2' })).toEqual(['forge tps']);
		expect(tickCommands({ modloader: 'neoforge', minecraftVersion: '1.21.1' })).toEqual(['neoforge tps', 'tick query']);
		expect(tickCommands({ modloader: 'fabric', minecraftVersion: '1.20.1' })).toEqual([]);
		expect(tickCommands({ modloader: 'fabric', minecraftVersion: '26.1' })).toEqual(['tick query']);
	});
});
