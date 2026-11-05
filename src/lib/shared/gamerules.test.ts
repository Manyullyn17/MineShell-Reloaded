import { describe, expect, it } from 'vitest';
import { isVanillaRule, ruleDefault } from './gamerules';

describe('ruleDefault', () => {
	it('knows a number rule under each name it has had', () => {
		expect(ruleDefault('randomTickSpeed')).toBe(3);
		expect(ruleDefault('random_tick_speed')).toBe(3);
		expect(ruleDefault('minecraft:random_tick_speed')).toBe(3);
	});

	it('keeps a default that changed with the rule apart: 1.21.1 and 1.21.11 differ', () => {
		expect(ruleDefault('playersNetherPortalCreativeDelay')).toBe(1);
		expect(ruleDefault('players_nether_portal_creative_delay')).toBe(0);
	});

	it('has none for an on or off rule or a mod\'s', () => {
		expect(ruleDefault('keepInventory')).toBeNull();
		expect(ruleDefault('someMod:rate')).toBeNull();
	});

	it('takes Minecraft\'s own rules of those versions for its own, not for a mod\'s', () => {
		for (const key of ['spawnChunkRadius', 'gameLoopFunction', 'fire_spread_radius_around_player', 'max_command_forks']) expect(isVanillaRule(key)).toBe(true);
	});
});
