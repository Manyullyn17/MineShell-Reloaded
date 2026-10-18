import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { itemIconsEnabled, itemName, serverResources } from './itemicons';
import { serverWorldName } from './packworld';
import { HEADLINES, headlineValue, STAT_CATEGORIES, statUnit, type StatCategory, type StatTable, type StatUnit } from '#lib/shared/playerstats.js';

/**
 * Player statistics: `<world>/stats/<uuid>.json`, written by the game when a
 * player leaves and on saves (1.7.2+). 1.13+ nests categories
 * (`{"stats": {"minecraft:mined": {"minecraft:stone": 12}}}`); before that
 * the file is flat keys (`stat.mineBlock.minecraft.stone`, `stat.walkOneCm`,
 * `stat.killEntity.Husk`, `achievement.*`), mapped here onto 1.13+'s names.
 * Only read, never written.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const emptyTable = (): StatTable => Object.fromEntries(STAT_CATEGORIES.map((c) => [c, {}])) as unknown as StatTable;

const add = (into: Record<string, number>, id: string, value: number) => {
	into[id] = (into[id] ?? 0) + value;
};

/** 1.12's flat key prefixes per category. */
const LEGACY_CATEGORIES: Record<string, StatCategory> = {
	mineBlock: 'mined',
	craftItem: 'crafted',
	useItem: 'used',
	breakItem: 'broken',
	pickup: 'picked_up',
	drop: 'dropped',
	killEntity: 'killed',
	entityKilledBy: 'killed_by'
};

/** 1.12 general stats whose 1.13+ id is not their name in snake case. */
const LEGACY_GENERAL: Record<string, string> = {
	playOneMinute: 'play_time',
	craftingTableInteraction: 'interact_with_crafting_table',
	furnaceInteraction: 'interact_with_furnace',
	brewingstandInteraction: 'interact_with_brewingstand',
	beaconInteraction: 'interact_with_beacon',
	chestOpened: 'open_chest',
	enderchestOpened: 'open_enderchest',
	shulkerBoxOpened: 'open_shulker_box',
	dispenserInspected: 'inspect_dispenser',
	dropperInspected: 'inspect_dropper',
	hopperInspected: 'inspect_hopper',
	itemEnchanted: 'enchant_item',
	recordPlayed: 'play_record',
	noteblockPlayed: 'play_noteblock',
	noteblockTuned: 'tune_noteblock',
	flowerPotted: 'pot_flower',
	trappedChestTriggered: 'trigger_trapped_chest',
	cakeSlicesEaten: 'eat_cake_slice',
	cauldronFilled: 'fill_cauldron',
	cauldronUsed: 'use_cauldron',
	armorCleaned: 'clean_armor',
	bannerCleaned: 'clean_banner'
};

/** 1.13-1.16 ids renamed since. */
const RENAMED: Record<string, string> = { 'minecraft:play_one_minute': 'minecraft:play_time' };

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** An item or block in a 1.12 key: `minecraft.stone` -> minecraft:stone; before 1.8 a number (`1`), kept as `#1`. */
function legacyItemId(rest: string): string {
	if (/^\d+$/.test(rest)) return `#${rest}`;
	const dot = rest.indexOf('.');
	return dot < 0 ? `minecraft:${rest}` : `${rest.slice(0, dot)}:${rest.slice(dot + 1)}`;
}

export function parseStats(json: unknown): StatTable {
	const table = emptyTable();
	if (!json || typeof json !== 'object') return table;
	const root = json as Record<string, unknown>;
	if (root.stats && typeof root.stats === 'object') {
		for (const [type, values] of Object.entries(root.stats as Record<string, unknown>)) {
			const category = type.replace(/^minecraft:/, '') as StatCategory;
			if (!STAT_CATEGORIES.includes(category) || !values || typeof values !== 'object') continue;
			for (const [id, value] of Object.entries(values as Record<string, unknown>)) {
				if (typeof value === 'number') add(table[category], category === 'custom' ? (RENAMED[id] ?? id) : id, value);
			}
		}
		return table;
	}
	for (const [key, value] of Object.entries(root)) {
		// 1.7-1.11 achievements are in the same file; some are objects with progress.
		if (typeof value !== 'number' || key.startsWith('achievement.')) continue;
		const grouped = /^stat\.([A-Za-z]+)\.(.+)$/.exec(key);
		const category = grouped ? LEGACY_CATEGORIES[grouped[1]] : undefined;
		if (grouped && category) {
			// Mobs by their 1.12 entity name (Husk, PigZombie, twilightforest.naga), as the lang keys know them.
			add(table[category], category === 'killed' || category === 'killed_by' ? grouped[2] : legacyItemId(grouped[2]), value);
			continue;
		}
		const general = /^stat\.([A-Za-z]+)$/.exec(key);
		if (general) add(table.custom, `minecraft:${LEGACY_GENERAL[general[1]] ?? snake(general[1])}`, value);
		// A mod's own (tombstone:villager_killed, stat.ae2.ItemsInserted), under its key.
		else add(table.custom, key, value);
	}
	return table;
}

// ------------------------------------------------------------------ files ---

export type PlayerStats = { uuid: string; stats: StatTable; modifiedAt: number };

/** Parsed files by path, while their size and time stay the same. */
const cache = new Map<string, { mtimeMs: number; size: number; stats: StatTable }>();

async function statsDir(instance: ServerInstance): Promise<string> {
	return path.join(instance.path, await serverWorldName(instance.path), 'stats');
}

async function readFile(file: string, uuid: string): Promise<PlayerStats | null> {
	const stat = await fs.stat(file).catch(() => null);
	if (!stat?.isFile()) return null;
	const hit = cache.get(file);
	if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { uuid, stats: hit.stats, modifiedAt: stat.mtimeMs };
	const text = await fs.readFile(file, 'utf8').catch(() => null);
	let json: unknown = null;
	try {
		json = text === null ? null : JSON.parse(text);
	} catch {
		// Being written, or broken: nothing to show.
	}
	if (json === null) return null;
	const stats = parseStats(json);
	cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, stats });
	return { uuid, stats, modifiedAt: stat.mtimeMs };
}

/** One player's stats in the active world, or null when the game has written none. */
export async function readPlayerStats(instance: ServerInstance, uuid: string): Promise<PlayerStats | null> {
	const id = uuid.toLowerCase();
	if (!UUID.test(id)) return null;
	return readFile(path.join(await statsDir(instance), `${id}.json`), id);
}

/** Every player's stats in the active world. */
export async function allPlayerStats(instance: ServerInstance): Promise<PlayerStats[]> {
	const dir = await statsDir(instance);
	const entries = await fs.readdir(dir).catch(() => [] as string[]);
	const found = await Promise.all(
		entries
			.filter((e) => e.endsWith('.json') && UUID.test(e.slice(0, -5).toLowerCase()))
			.map((e) => readFile(path.join(dir, e), e.slice(0, -5).toLowerCase()))
	);
	return found.filter((s): s is PlayerStats => !!s);
}

// ------------------------------------------------------------------ names ---

/** Vanilla general stats' English names (1.21.11's en_us.json; dive and fishing from 1.12's). */
const VANILLA_NAMES: Record<string, string> = {
	animals_bred: 'Animals Bred',
	aviate_one_cm: 'Distance by Elytra',
	bell_ring: 'Bells Rung',
	boat_one_cm: 'Distance by Boat',
	clean_armor: 'Armor Pieces Cleaned',
	clean_banner: 'Banners Cleaned',
	clean_shulker_box: 'Shulker Boxes Cleaned',
	climb_one_cm: 'Distance Climbed',
	crouch_one_cm: 'Distance Crouched',
	damage_absorbed: 'Damage Absorbed',
	damage_blocked_by_shield: 'Damage Blocked by Shield',
	damage_dealt: 'Damage Dealt',
	damage_dealt_absorbed: 'Damage Dealt (Absorbed)',
	damage_dealt_resisted: 'Damage Dealt (Resisted)',
	damage_resisted: 'Damage Resisted',
	damage_taken: 'Damage Taken',
	deaths: 'Number of Deaths',
	dive_one_cm: 'Distance Dove',
	drop: 'Items Dropped',
	eat_cake_slice: 'Cake Slices Eaten',
	enchant_item: 'Items Enchanted',
	fall_one_cm: 'Distance Fallen',
	fill_cauldron: 'Cauldrons Filled',
	fish_caught: 'Fish Caught',
	fly_one_cm: 'Distance Flown',
	happy_ghast_one_cm: 'Distance by Happy Ghast',
	horse_one_cm: 'Distance by Horse',
	inspect_dispenser: 'Dispensers Searched',
	inspect_dropper: 'Droppers Searched',
	inspect_hopper: 'Hoppers Searched',
	interact_with_anvil: 'Interactions with Anvil',
	interact_with_beacon: 'Interactions with Beacon',
	interact_with_blast_furnace: 'Interactions with Blast Furnace',
	interact_with_brewingstand: 'Interactions with Brewing Stand',
	interact_with_campfire: 'Interactions with Campfire',
	interact_with_cartography_table: 'Interactions with Cartography Table',
	interact_with_crafting_table: 'Interactions with Crafting Table',
	interact_with_furnace: 'Interactions with Furnace',
	interact_with_grindstone: 'Interactions with Grindstone',
	interact_with_lectern: 'Interactions with Lectern',
	interact_with_loom: 'Interactions with Loom',
	interact_with_smithing_table: 'Interactions with Smithing Table',
	interact_with_smoker: 'Interactions with Smoker',
	interact_with_stonecutter: 'Interactions with Stonecutter',
	jump: 'Jumps',
	junk_fished: 'Junk Fished',
	leave_game: 'Games Quit',
	minecart_one_cm: 'Distance by Minecart',
	mob_kills: 'Mob Kills',
	nautilus_one_cm: 'Distance by Nautilus',
	open_barrel: 'Barrels Opened',
	open_chest: 'Chests Opened',
	open_enderchest: 'Ender Chests Opened',
	open_shulker_box: 'Shulker Boxes Opened',
	pig_one_cm: 'Distance by Pig',
	play_noteblock: 'Note Blocks Played',
	play_record: 'Music Discs Played',
	play_time: 'Time Played',
	player_kills: 'Player Kills',
	pot_flower: 'Plants Potted',
	raid_trigger: 'Raids Triggered',
	raid_win: 'Raids Won',
	sleep_in_bed: 'Times Slept in a Bed',
	sneak_time: 'Sneak Time',
	sprint_one_cm: 'Distance Sprinted',
	strider_one_cm: 'Distance by Strider',
	swim_one_cm: 'Distance Swum',
	talked_to_villager: 'Talked to Villagers',
	target_hit: 'Targets Hit',
	time_since_death: 'Time Since Last Death',
	time_since_rest: 'Time Since Last Rest',
	total_world_time: 'Time with World Open',
	traded_with_villager: 'Traded with Villagers',
	treasure_fished: 'Treasure Fished',
	trigger_trapped_chest: 'Trapped Chests Triggered',
	tune_noteblock: 'Note Blocks Tuned',
	use_cauldron: 'Water Taken from Cauldron',
	walk_on_water_one_cm: 'Distance Walked on Water',
	walk_one_cm: 'Distance Walked',
	walk_under_water_one_cm: 'Distance Walked under Water'
};

/** "villager_killed", "ItemsInserted", "PigZombie" -> words, first letter up. */
function tidy(text: string): string {
	const words = text
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.split(/[_\s]+/)
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const last = (id: string) => id.split(/[:.]/).pop() ?? id;

/** A general stat's name: vanilla's, else the mod's lang key, else its id tidied up. */
export function customStatName(id: string, lang: Map<string, string>): string {
	const [ns, p] = id.includes(':') ? [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)] : ['', id];
	if (ns === 'minecraft' && VANILLA_NAMES[p]) return VANILLA_NAMES[p];
	const name = (ns && lang.get(`stat.${ns}.${p}`)) || lang.get(id) || lang.get(`stat.${id}`);
	return name || tidy(last(id));
}

/** A mob's name: 1.13+ `entity.<ns>.<path>`, 1.12 `entity.<name>.name` (mods' names carry their namespace). */
export function entityName(id: string, lang: Map<string, string>): string {
	const name = id.includes(':')
		? lang.get(`entity.${id.replace(':', '.')}`)
		: lang.get(`entity.${id}.name`) ?? lang.get(`entity.${id.toLowerCase()}.name`);
	return name || tidy(last(id));
}

/** The language lines of the server's jars, when item pictures are on (they read the same jars); none otherwise. */
async function serverLang(instance: ServerInstance): Promise<Map<string, string>> {
	if (!itemIconsEnabled()) return new Map();
	return serverResources(instance)
		.then((res) => res.lang())
		.catch(() => new Map());
}

export type StatNames = Record<StatCategory, Record<string, string>>;

/** Names for every id in `tables`, per category (those in `only`). */
export async function statNames(instance: ServerInstance, tables: StatTable[], only: readonly StatCategory[] = STAT_CATEGORIES): Promise<StatNames> {
	const lang = await serverLang(instance);
	const names = Object.fromEntries(STAT_CATEGORIES.map((c) => [c, {}])) as unknown as StatNames;
	for (const table of tables) {
		for (const category of only) {
			for (const id of Object.keys(table[category])) {
				if (names[category][id]) continue;
				names[category][id] =
					category === 'custom'
						? customStatName(id, lang)
						: category === 'killed' || category === 'killed_by'
							? entityName(id, lang)
							: id.startsWith('#')
								? `Item ${id.slice(1)}`
								: itemName(id, lang);
			}
		}
	}
	return names;
}

export type Leaderboard = {
	/** Each player's headline numbers and general stats, by id. */
	players: { uuid: string; values: Record<string, number> }[];
	/** The general stats any player has, beyond the headlines, by name. */
	others: { id: string; name: string; unit: StatUnit }[];
};

/**
 * What the Players page ranks players by: the players it lists, those with a
 * player file. A stats file can outlive one (deleted to drop someone who
 * joined once), and its player stays gone from the ranking too.
 */
export async function leaderboard(instance: ServerInstance, players: ReadonlySet<string>): Promise<Leaderboard> {
	const all = (await allPlayerStats(instance)).filter((p) => players.has(p.uuid));
	const names = await statNames(instance, all.map((p) => p.stats), ['custom']);
	const headlines = new Set(HEADLINES.map((h) => h.id));
	return {
		players: all.map((p) => ({
			uuid: p.uuid,
			values: { ...p.stats.custom, ...Object.fromEntries(HEADLINES.map((h) => [h.id, headlineValue(p.stats, h.id)])) }
		})),
		others: Object.entries(names.custom)
			.filter(([id]) => !headlines.has(id))
			.map(([id, name]) => ({ id, name, unit: statUnit(id) }))
			.sort((a, b) => a.name.localeCompare(b.name))
	};
}
