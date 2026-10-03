import { describe, expect, it } from 'vitest';
import type { Compound } from './nbt';
import { parseSnbt } from './snbt';
import { addEffect, customFieldViews, playerEffects, playerFields } from './playerfields';
import { PlayerDataError } from './playeritems';

const snbt = (text: string) => parseSnbt(text) as Compound;
const byKey = (root: Compound) => Object.fromEntries(playerFields(root).map((f) => [f.key, f]));

describe('playerFields', () => {
	it('shows the fields the file has, where this version keeps them', () => {
		const old = byKey(snbt('{Health:20f,abilities:{mayfly:1b,walkSpeed:0.1f},SpawnX:10,SpawnY:64,SpawnZ:-3,SpawnForced:0b,FallDistance:2.5f}'));
		expect(old.health).toMatchObject({ value: '20', type: 'float', group: 'basic' });
		expect(old.mayfly).toMatchObject({ kind: 'checkbox', value: true, path: ['abilities', 'mayfly'], group: 'advanced' });
		expect(old.walkSpeed).toMatchObject({ value: '0.1' });
		expect(old.spawnX).toMatchObject({ value: '10' });
		expect(old.fall).toMatchObject({ path: ['FallDistance'] });
		expect(old.spawn).toBeUndefined();
		// Nothing in the file, no field.
		expect(old.food).toBeUndefined();

		// 1.21.5 moved the spawn point and renamed the fall distance.
		const modern = byKey(snbt('{respawn:{pos:[I;1,70,2],dimension:"minecraft:overworld",forced:1b},fall_distance:0d,Dimension:"minecraft:the_nether"}'));
		expect(modern.spawn).toMatchObject({ value: '1, 70, 2', type: 'intArray' });
		expect(modern.spawnDimension).toMatchObject({ kind: 'text', value: 'minecraft:overworld' });
		expect(modern.spawnForced).toMatchObject({ kind: 'checkbox', value: true });
		expect(modern.fall).toMatchObject({ path: ['fall_distance'] });
		expect(modern.dimension).toMatchObject({ kind: 'text', value: 'minecraft:the_nether' });
	});

	it('lists attribute base values by name, old and new spelling', () => {
		const old = playerFields(snbt('{Attributes:[{Name:"generic.maxHealth",Base:20d},{Name:"generic.movementSpeed",Base:0.1d}]}'));
		expect(old.map((f) => [f.label, f.value, f.path])).toEqual([
			['maxHealth', '20', ['Attributes', 0, 'Base']],
			['movementSpeed', '0.1', ['Attributes', 1, 'Base']]
		]);
		const modern = playerFields(snbt('{attributes:[{id:"minecraft:max_health",base:40d}]}'));
		expect(modern[0]).toMatchObject({ label: 'max health', value: '40', group: 'attributes', path: ['attributes', 0, 'base'] });
	});
});

describe('effects', () => {
	it('reads numeric (to 1.20.1) and string ids, levels and seconds', () => {
		const old = playerEffects(snbt('{ActiveEffects:[{Id:1b,Amplifier:1b,Duration:600}]}'), 1343);
		expect(old.effects).toMatchObject([{ id: 'minecraft:speed', level: 2, seconds: 30, levelPath: ['ActiveEffects', 0, 'Amplifier'] }]);
		const modern = playerEffects(snbt('{active_effects:[{id:"minecraft:night_vision",amplifier:0b,duration:-1}]}'), 3955);
		expect(modern.effects).toMatchObject([{ id: 'minecraft:night_vision', level: 1, seconds: -1 }]);
	});

	it('adds effects in the file’s format', () => {
		const old = snbt('{}');
		addEffect(old, 1343, { id: 'minecraft:speed', level: 2, seconds: 30 });
		expect(old.value[0]).toEqual([
			'ActiveEffects',
			parseSnbt('[{Id:1b,Amplifier:1b,Duration:600,Ambient:0b,ShowParticles:1b,ShowIcon:1b}]')
		]);
		const modern = snbt('{active_effects:[]}');
		addEffect(modern, 3955, { id: 'minecraft:haste', level: 1, seconds: -1 });
		expect(playerEffects(modern, 3955).effects).toMatchObject([{ id: 'minecraft:haste', level: 1, seconds: -1 }]);
		expect(() => addEffect(old, 1343, { id: 'minecraft:made_up', level: 1, seconds: 1 })).toThrow(PlayerDataError);
		// The entries already there decide, not the DataVersion.
		const mixed = snbt('{ActiveEffects:[{Id:1b,Amplifier:0b,Duration:20}]}');
		addEffect(mixed, 3700, { id: 'minecraft:haste', level: 1, seconds: 1 });
		expect(playerEffects(mixed, 3700).effects.map((e) => e.id)).toEqual(['minecraft:speed', 'minecraft:haste']);
		expect(JSON.stringify(mixed)).not.toContain('"amplifier"');
		expect(() => addEffect(modern, 3955, { id: 'minecraft:haste', level: 0, seconds: 1 })).toThrow(/1 to 128/);
	});
});

describe('customFieldViews', () => {
	it('resolves each mapped field, and says why one no longer fits', () => {
		const root = snbt('{ManaData:{mana:120f,unlocked:1b},Tags:["a"]}');
		const views = customFieldViews(root, [
			{ id: 1, label: 'Mana', path: ['ManaData', 'mana'], kind: 'number' },
			{ id: 2, label: 'Unlocked', path: ['ManaData', 'unlocked'], kind: 'checkbox' },
			{ id: 3, label: 'Gone', path: ['Old', 'x'], kind: 'number' },
			{ id: 4, label: 'Wrong kind', path: ['Tags'], kind: 'number' }
		]);
		expect(views.map((v) => [v.label, v.field?.value ?? null, v.problem])).toEqual([
			['Mana', '120', null],
			['Unlocked', true, null],
			['Gone', null, 'This player’s data has nothing there.'],
			['Wrong kind', null, 'There is a list there now, which a number field cannot show.']
		]);
	});
});
