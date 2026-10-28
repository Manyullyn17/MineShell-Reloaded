import { describe, expect, it } from 'vitest';
import { parseTickOutput, tickCommands } from './tps';

describe('parseTickOutput', () => {
	it('reads Forge 1.12', () => {
		const out = 'Dim  0 : Mean tick time: 0.402 ms. Mean TPS: 20.000\nOverall : Mean tick time: 0.853 ms. Mean TPS: 20.000';
		expect(parseTickOutput(out)).toEqual({ mspt: 0.853, tps: 20, dimensions: [{ id: '0', label: 'Overworld', mspt: 0.402, tps: 20 }] });
	});

	it('reads Forge 1.12 as it answers over RCON (recorded from 14.23.5.2864: lines run together)', () => {
		const out = 'Dim  0 (overworld) : Mean tick time: 1.527 ms. Mean TPS: 20.000Overall : Mean tick time: 1.589 ms. Mean TPS: 20.000\n';
		expect(parseTickOutput(out)).toEqual({ mspt: 1.589, tps: 20, dimensions: [{ id: '0', label: 'Overworld', mspt: 1.527, tps: 20 }] });
	});

	it("reads Forge 1.12's mod dimensions, named by their type", () => {
		const out =
			'Dim  0 (overworld) : Mean tick time: 12.500 ms. Mean TPS: 20.000Dim -1 (the_nether) : Mean tick time: 0.300 ms. Mean TPS: 20.000' +
			'Dim  7 (TwilightForest) : Mean tick time: 71.400 ms. Mean TPS: 14.006Dim -11325 : Mean tick time: 0.010 ms. Mean TPS: 20.000' +
			'Overall : Mean tick time: 84.210 ms. Mean TPS: 11.875';
		expect(parseTickOutput(out)).toEqual({
			mspt: 84.21,
			tps: 11.875,
			dimensions: [
				{ id: '0', label: 'Overworld', mspt: 12.5, tps: 20 },
				{ id: '-1', label: 'The Nether', mspt: 0.3, tps: 20 },
				{ id: '7', label: 'Twilight Forest (DIM7)', mspt: 71.4, tps: 14.006 },
				{ id: '-11325', label: 'DIM-11325', mspt: 0.01, tps: 20 }
			]
		});
	});

	it('reads modern Forge, including a comma-decimal locale', () => {
		expect(parseTickOutput('Overall: Mean tick time: 61,250 ms. Mean TPS: 16,327')).toEqual({ mspt: 61.25, tps: 16.327, dimensions: [] });
	});

	it("reads modern Forge's dimensions, level then dimension type", () => {
		const out =
			'Dim minecraft:overworld (minecraft:overworld): Mean tick time: 3.100 ms. Mean TPS: 20.000' +
			'Dim twilightforest:twilight_forest (twilightforest:twilight_forest_type): Mean tick time: 55.000 ms. Mean TPS: 18.182' +
			'Overall: Mean tick time: 58.400 ms. Mean TPS: 17.123';
		expect(parseTickOutput(out)?.dimensions).toEqual([
			{ id: 'minecraft:overworld', label: 'Overworld', mspt: 3.1, tps: 20 },
			{ id: 'twilightforest:twilight_forest', label: 'twilightforest:twilight_forest', mspt: 55, tps: 18.182 }
		]);
	});

	it('reads NeoForge as it answers over RCON (recorded from 21.1.265: dimensions by name)', () => {
		const out =
			'Overworld: 20.000 TPS (0.167 ms/tick)\nThe End: 20.000 TPS (0.008 ms/tick)\nThe Nether: 20.000 TPS (0.004 ms/tick)\nOverall: 20.000 TPS (0.192 ms/tick)\n\n';
		expect(parseTickOutput(out)).toEqual({
			tps: 20,
			mspt: 0.192,
			dimensions: [
				{ id: 'Overworld', label: 'Overworld', tps: 20, mspt: 0.167 },
				{ id: 'The End', label: 'The End', tps: 20, mspt: 0.008 },
				{ id: 'The Nether', label: 'The Nether', tps: 20, mspt: 0.004 }
			]
		});
	});

	it('reads NeoForge, with lines on their own or run together', () => {
		expect(parseTickOutput('minecraft:overworld: 20.000 TPS (1.100 ms/tick)\nOverall: 20.000 TPS (1.234 ms/tick)')).toEqual({
			tps: 20,
			mspt: 1.234,
			dimensions: [{ id: 'minecraft:overworld', label: 'Overworld', tps: 20, mspt: 1.1 }]
		});
		const out = 'minecraft:overworld: 20.000 TPS (1.100 ms/tick)minecraft:the_end: 19,500 TPS (51,300 ms/tick)Overall: 19.800 TPS (52.400 ms/tick)';
		expect(parseTickOutput(out)?.dimensions).toEqual([
			{ id: 'minecraft:overworld', label: 'Overworld', tps: 20, mspt: 1.1 },
			{ id: 'minecraft:the_end', label: 'The End', tps: 19.5, mspt: 51.3 }
		]);
	});

	it('reads vanilla tick query (recorded from a 1.21.1 server), capping TPS at the target', () => {
		const out =
			'The game is running normallyTarget tick rate: 20.0 per second.\nAverage time per tick: 0.3ms (Target: 50.0ms)Percentiles: P50: 0.2ms P95: 0.8ms P99: 4.7ms, sample: 100';
		expect(parseTickOutput(out)).toEqual({ mspt: 0.3, tps: 20, dimensions: [] });
		expect(parseTickOutput('Target tick rate: 20.0 per second.\nAverage time per tick: 80.0ms (Target: 50.0ms)')).toEqual({ mspt: 80, tps: 12.5, dimensions: [] });
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
