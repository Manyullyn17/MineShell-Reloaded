import { describe, expect, it } from 'vitest';
import { asksAtStartup, parseForgeQuestion } from './forgequery';

const PROMPT = [
	'Run the command /fml confirm or or /fml cancel to proceed.',
	'Alternatively start the server with -Dfml.queryResult=confirm or -Dfml.queryResult=cancel to preselect the answer.'
];

describe('parseForgeQuestion', () => {
	// meatballcraft-cleanroom's journal on 2026-10-08 (Cleanroom 0.5.17), shortened.
	it('reads missing registry entries, grouped by registry', () => {
		const lines = [
			'[23:25:55] [Server thread/WARN] [FML]: Forge Mod Loader detected missing registry entries.',
			'There are 6 missing entries in this save.',
			'If you continue the missing entries will get removed.',
			'A world backup will be automatically created in your saves directory.',
			'Missing minecraft:blocks:',
			'    contenttweaker:kami_essence_block',
			'    tconstruct:molten_enderium',
			'Missing minecraft:items:',
			'    contenttweaker:kami_cloth',
			'    thaumictinkerer:dummy_nitor',
			'Missing minecraft:soundevents:',
			'    rftools:elevator_loop',
			'    integrateddynamics:effect.page.flipsingle',
			...PROMPT
		];
		const question = parseForgeQuestion(lines, 1000);
		expect(question).toMatchObject({ kind: 'missing-entries', askedAt: 1000 });
		expect(question!.groups).toEqual([
			{ name: 'minecraft:blocks', entries: ['contenttweaker:kami_essence_block', 'tconstruct:molten_enderium'] },
			{ name: 'minecraft:items', entries: ['contenttweaker:kami_cloth', 'thaumictinkerer:dummy_nitor'] },
			{ name: 'minecraft:soundevents', entries: ['rftools:elevator_loop', 'integrateddynamics:effect.page.flipsingle'] }
		]);
		expect(question!.text.split('\n')[0]).toBe('Forge Mod Loader detected missing registry entries.');
		expect(question!.text).not.toContain('/fml confirm');
	});

	// GameData.injectSnapshot's text in Forge 1.12.2-14.23.5.2860 and Cleanroom (read with javap).
	it('reads missing registries', () => {
		const lines = [
			'[10:00:00] [Server thread/WARN] [FML]: Forge Mod Loader detected missing/unknown registrie(s).',
			'',
			'There are 2 missing registries in this save.',
			'If you continue the missing registries will get removed.',
			'This may cause issues, it is advised that you create a world backup before continuing.',
			'',
			'Missing Registries:',
			'examplemod:widgets',
			'othermod:spells',
			'',
			'',
			...PROMPT
		];
		expect(parseForgeQuestion(lines, 1)).toMatchObject({
			kind: 'missing-registries',
			groups: [{ name: 'registries', entries: ['examplemod:widgets', 'othermod:spells'] }]
		});
	});

	it('reads the backup level.dat question, and keeps its text', () => {
		const lines = [
			'[10:00:00] [Server thread/WARN] [FML]: Forge Mod Loader detected that the backup level.dat is being used.',
			'This may happen due to a bug or corruption, continuing can damage',
			'your world beyond repair or lose data / progress.',
			"It's recommended to create a world backup before continuing.",
			...PROMPT
		];
		const question = parseForgeQuestion(lines, 1)!;
		expect(question.kind).toBe('backup-level-dat');
		expect(question.groups).toEqual([]);
		expect(question.text).toContain('continuing can damage');
	});

	// Older Forge words its questions differently but ends them the same way.
	it('takes a question it does not know as it is, starting at its own first line', () => {
		const lines = [
			'[10:00:00] [Version Check/INFO] [forge.VersionCheck]: [forge] Found status: OUTDATED',
			'[10:00:00] [Server thread/WARN] [FML]: Forge Mod Loader detected missing blocks/items.',
			'Some things are gone.',
			...PROMPT
		];
		expect(parseForgeQuestion(lines, 1)).toEqual({
			kind: 'other',
			askedAt: 1,
			text: 'Forge Mod Loader detected missing blocks/items.\nSome things are gone.',
			groups: []
		});
	});

	it('finds nothing without the prompt', () => {
		expect(parseForgeQuestion(['[10:00:00] [Server thread/WARN] [FML]: Forge Mod Loader detected missing registry entries.'], 1)).toBeNull();
	});
});

describe('asksAtStartup', () => {
	it('is Forge before 1.13 and Cleanroom', () => {
		expect(asksAtStartup({ modloader: 'forge', minecraftVersion: '1.12.2' })).toBe(true);
		expect(asksAtStartup({ modloader: 'forge', minecraftVersion: '1.7.10' })).toBe(true);
		expect(asksAtStartup({ modloader: 'cleanroom', minecraftVersion: '1.12.2' })).toBe(true);
		expect(asksAtStartup({ modloader: 'forge', minecraftVersion: '1.13.2' })).toBe(false);
		expect(asksAtStartup({ modloader: 'forge', minecraftVersion: '1.20.1' })).toBe(false);
		expect(asksAtStartup({ modloader: 'neoforge', minecraftVersion: '1.21.1' })).toBe(false);
	});
});
