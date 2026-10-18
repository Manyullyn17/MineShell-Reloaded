import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { customStatName, entityName, parseStats } from './playerstats';
import { formatCm, formatDamage, formatStat, formatTicks, headlineValue, overflowed, statUnit } from '#lib/shared/playerstats.js';

describe('reading stats files', () => {
	it('reads 1.13+ categories, and 1.13-1.16 play_one_minute as play time', () => {
		const stats = parseStats({
			stats: {
				'minecraft:custom': { 'minecraft:play_one_minute': 72000, 'minecraft:walk_one_cm': 150, 'create:wrench_used': 3 },
				'minecraft:mined': { 'minecraft:stone': 12 },
				'minecraft:killed': { 'minecraft:pillager': 4 },
				'somemod:own_type': { 'somemod:x': 1 }
			},
			DataVersion: 2586
		});
		expect(stats.custom).toEqual({ 'minecraft:play_time': 72000, 'minecraft:walk_one_cm': 150, 'create:wrench_used': 3 });
		expect(stats.mined).toEqual({ 'minecraft:stone': 12 });
		expect(stats.killed).toEqual({ 'minecraft:pillager': 4 });
	});

	it("maps 1.12's flat keys onto the same categories and ids", () => {
		const stats = parseStats({
			'stat.playOneMinute': 11934358,
			'stat.walkOneCm': 20110782,
			'stat.craftingTableInteraction': 34,
			'stat.mobKills': 6200,
			'stat.drop': 135,
			'stat.mineBlock.minecraft.stone': 40,
			'stat.mineBlock.thebetweenlands.pale_grass': 2,
			'stat.drop.minecraft.dirt': 7,
			'stat.pickup.minecraft.dirt': 9,
			'stat.killEntity.Husk': 3,
			'stat.killEntity.twilightforest.naga': 1,
			'stat.entityKilledBy.PigZombie': 2,
			'tombstone:villager_killed': 1,
			'stat.mineBlock.1': 5,
			'achievement.openInventory': 1,
			'achievement.exploreAllBiomes': { value: 0, progress: ['Beach'] }
		});
		expect(stats.custom).toEqual({
			'minecraft:play_time': 11934358,
			'minecraft:walk_one_cm': 20110782,
			'minecraft:interact_with_crafting_table': 34,
			'minecraft:mob_kills': 6200,
			'minecraft:drop': 135,
			'tombstone:villager_killed': 1
		});
		expect(stats.mined).toEqual({ 'minecraft:stone': 40, 'thebetweenlands:pale_grass': 2, '#1': 5 });
		expect(stats.dropped).toEqual({ 'minecraft:dirt': 7 });
		expect(stats.picked_up).toEqual({ 'minecraft:dirt': 9 });
		expect(stats.killed).toEqual({ Husk: 3, 'twilightforest.naga': 1 });
		expect(stats.killed_by).toEqual({ PigZombie: 2 });
	});

	it("marks a counter that wrapped past 2.1 billion as overflowed, and every total over it (erzark's damage on MeatballCraft)", () => {
		const stats = parseStats({
			'stat.damageTaken': -2147399778,
			'stat.damageDealt': 3698585,
			'stat.walkOneCm': 100,
			'stat.flyOneCm': -5,
			'stat.mineBlock.minecraft.stone': -1,
			'stat.mineBlock.minecraft.dirt': 4
		});
		expect(overflowed(headlineValue(stats, 'minecraft:damage_taken'))).toBe(true);
		expect(formatStat(headlineValue(stats, 'minecraft:damage_taken'), 'damage')).toBe('overflowed');
		expect(headlineValue(stats, 'minecraft:damage_dealt')).toBe(3698585);
		expect(overflowed(headlineValue(stats, 'total:distance'))).toBe(true);
		expect(overflowed(headlineValue(stats, 'total:mined'))).toBe(true);
		expect(stats.mined['minecraft:dirt']).toBe(4);
	});

	it('reads nothing from something that is not a stats file', () => {
		expect(parseStats(null).custom).toEqual({});
		expect(parseStats([1, 2]).mined).toEqual({});
	});

	it('names general stats and mobs from the lang files, else tidies the id', () => {
		const lang = new Map([
			['stat.create.wrench_used', 'Wrench Uses'],
			['entity.minecraft.pillager', 'Pillager'],
			['entity.PigZombie.name', 'Zombie Pigman']
		]);
		expect(customStatName('minecraft:play_time', lang)).toBe('Time Played');
		expect(customStatName('create:wrench_used', lang)).toBe('Wrench Uses');
		expect(customStatName('tombstone:villager_killed', lang)).toBe('Villager Killed');
		expect(customStatName('stat.ae2.ItemsInserted', lang)).toBe('Items Inserted');
		expect(entityName('minecraft:pillager', lang)).toBe('Pillager');
		expect(entityName('PigZombie', lang)).toBe('Zombie Pigman');
		expect(entityName('twilightforest.naga', lang)).toBe('Naga');
	});

	it('reads the files of real servers alike (irithyll 1.21.11 and MeatballCraft 1.12.2, trimmed)', async () => {
		const dir = path.join(import.meta.dirname, '../../../tests/fixtures/stats');
		const modern = parseStats(JSON.parse(await fs.readFile(path.join(dir, 'modern.json'), 'utf8')));
		const legacy = parseStats(JSON.parse(await fs.readFile(path.join(dir, 'legacy.json'), 'utf8')));
		for (const stats of [modern, legacy]) {
			expect(headlineValue(stats, 'minecraft:play_time')).toBeGreaterThan(0);
			expect(headlineValue(stats, 'total:distance')).toBeGreaterThan(0);
			expect(headlineValue(stats, 'total:mined')).toBeGreaterThan(0);
			expect(Object.keys(stats.killed).length).toBeGreaterThan(0);
		}
	});
});

describe('showing stats', () => {
	it('shows time to the second under an hour, to the minute under a day, then days and hours', () => {
		expect(formatTicks(0)).toBe('0s');
		expect(formatTicks(45 * 20)).toBe('45s');
		expect(formatTicks((12 * 60 + 30) * 20)).toBe('12m 30s');
		expect(formatTicks((5 * 3600 + 12 * 60 + 59) * 20)).toBe('5h 12m');
		expect(formatTicks((3 * 86400 + 4 * 3600 + 59 * 60) * 20)).toBe('3d 4h');
	});

	it('shows distance in cm, m and km', () => {
		expect(formatCm(35)).toBe('35 cm');
		expect(formatCm(350)).toBe('3.5 m');
		expect(formatCm(51_200)).toBe('512 m');
		expect(formatCm(1_234_567)).toBe('12.3 km');
		expect(formatCm(188_836_315)).toBe('1,888 km');
	});

	it('shows damage in hearts', () => {
		expect(formatDamage(20)).toBe('1 heart');
		expect(formatDamage(725)).toBe('36.3 hearts');
		expect(formatDamage(1_256_642)).toBe('62,832 hearts');
	});

	it('knows the units of vanilla stats, and counts what mods add', () => {
		expect(statUnit('minecraft:play_time')).toBe('time');
		expect(statUnit('minecraft:time_since_death')).toBe('time');
		expect(statUnit('minecraft:aviate_one_cm')).toBe('distance');
		expect(statUnit('minecraft:damage_blocked_by_shield')).toBe('damage');
		expect(statUnit('minecraft:jump')).toBe('count');
		expect(statUnit('somemod:walk_one_cm')).toBe('count');
		expect(formatStat(191803, 'count')).toBe('191,803');
	});

	it('adds every way of moving but falling into distance travelled', () => {
		const stats = parseStats({ stats: { 'minecraft:custom': { 'minecraft:walk_one_cm': 100, 'minecraft:aviate_one_cm': 50, 'minecraft:fall_one_cm': 1000 } } });
		expect(headlineValue(stats, 'total:distance')).toBe(150);
	});
});
