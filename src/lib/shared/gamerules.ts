/**
 * Minecraft's own game rules, by the name a world stores: camelCase in level.dat up to
 * 1.21.10, `minecraft:`-less snake_case from 1.21.11 (level.dat's game_rules, then 26's
 * data/minecraft/game_rules.dat). English names and descriptions from the server jars'
 * en_us.json (26.3's, which keeps the old keys); a rule renamed in 1.21.11 with the same
 * meaning has its old name's text, one turned around (raids, the movement checks) its own.
 * Made with tests/tools/gamerules-dump.mjs on mc-probe worlds (2026-11-03). A rule not here
 * (a mod's, or one before 1.13) is named after its key.
 */
export const VANILLA_GAME_RULES: Record<string, { name: string; description?: string }> = {
	allowEnteringNetherUsingPortals: { name: 'Allow Nether', description: 'Controls whether players are allowed to enter the Nether.' },
	allowFireTicksAwayFromPlayer: { name: 'Tick fire away from players', description: 'Controls whether fire and lava should be able to tick further than 8 chunks away from any player.' },
	announceAdvancements: { name: 'Announce advancements' },
	blockExplosionDropDecay: { name: 'In block interaction explosions, some blocks won\'t drop their loot', description: 'Some of the drops from blocks destroyed by explosions caused by block interactions are lost in the explosion.' },
	commandBlockOutput: { name: 'Broadcast command block output' },
	commandBlocksEnabled: { name: 'Enable Command Blocks' },
	commandModificationBlockLimit: { name: 'Command modification block limit', description: 'The number of blocks that can be changed at once by one command, such as fill or clone.' },
	disableElytraMovementCheck: { name: 'Disable elytra movement check' },
	disablePlayerMovementCheck: { name: 'Disable player movement check' },
	disableRaids: { name: 'Disable raids' },
	doDaylightCycle: { name: 'Advance time of day' },
	doEntityDrops: { name: 'Drop entity equipment', description: 'Controls drops from Minecarts (including inventories), Item Frames, Boats, etc.' },
	doFireTick: { name: 'Update fire' },
	doImmediateRespawn: { name: 'Respawn immediately' },
	doInsomnia: { name: 'Spawn phantoms' },
	doLimitedCrafting: { name: 'Require recipe for crafting', description: 'If enabled, players will be able to craft only unlocked recipes.' },
	doMobLoot: { name: 'Drop mob loot', description: 'Controls resource drops from mobs, including experience orbs.' },
	doMobSpawning: { name: 'Spawn mobs', description: 'Some entities might have separate rules.' },
	doPatrolSpawning: { name: 'Spawn pillager patrols' },
	doTileDrops: { name: 'Drop blocks', description: 'Controls resource drops from blocks, including experience orbs.' },
	doTraderSpawning: { name: 'Spawn Wandering Traders' },
	doVinesSpread: { name: 'Vines spread', description: 'Controls whether the Vines block spreads randomly to adjacent blocks. Does not affect other types of vine blocks such as Weeping Vines, Twisting Vines, etc.' },
	doWardenSpawning: { name: 'Spawn Wardens' },
	doWeatherCycle: { name: 'Update weather' },
	drowningDamage: { name: 'Deal drowning damage' },
	enderPearlsVanishOnDeath: { name: 'Thrown Ender Pearls vanish on death', description: 'Whether Ender Pearls thrown by a player vanish when that player dies.' },
	gameLoopFunction: { name: 'Game loop function', description: 'The function run every tick (1.12; empty for none).' },
	fallDamage: { name: 'Deal fall damage' },
	fireDamage: { name: 'Deal fire damage' },
	forgiveDeadPlayers: { name: 'Forgive dead players', description: 'Angered neutral mobs stop being angry when the targeted player dies nearby.' },
	freezeDamage: { name: 'Deal freeze damage' },
	globalSoundEvents: { name: 'Global sound events', description: 'When certain game events happen, like a boss spawning, the sound is heard everywhere.' },
	keepInventory: { name: 'Keep inventory after death' },
	lavaSourceConversion: { name: 'Lava converts to source', description: 'When flowing lava is surrounded on two sides by lava sources, it converts into a source.' },
	locatorBar: { name: 'Enable player Locator Bar', description: 'When enabled, a bar is shown on the screen to indicate the direction of players.' },
	logAdminCommands: { name: 'Broadcast admin commands' },
	maxCommandChainLength: { name: 'Command chain size limit', description: 'Applies to command block chains and functions.' },
	maxCommandForkCount: { name: 'Command context limit', description: 'Maximum number of contexts that can be used by commands like \'execute as\'.' },
	maxEntityCramming: { name: 'Entity cramming threshold' },
	mobExplosionDropDecay: { name: 'In mob explosions, some blocks won\'t drop their loot', description: 'Some of the drops from blocks destroyed by explosions caused by mobs are lost in the explosion.' },
	mobGriefing: { name: 'Allow destructive mob actions' },
	naturalRegeneration: { name: 'Regenerate health' },
	playersNetherPortalCreativeDelay: { name: 'Player\'s Nether Portal delay in creative mode', description: 'Time (in ticks) that a creative mode player needs to stand in a Nether Portal before changing dimensions.' },
	playersNetherPortalDefaultDelay: { name: 'Player\'s Nether Portal delay in non-creative mode', description: 'Time (in ticks) that a non-creative mode player needs to stand in a Nether Portal before changing dimensions.' },
	playersSleepingPercentage: { name: 'Sleep percentage', description: 'The percentage of players who must be sleeping to skip the night.' },
	projectilesCanBreakBlocks: { name: 'Projectiles can break blocks', description: 'Controls whether impact projectiles will destroy blocks that are destructible by them.' },
	pvp: { name: 'Enable pvp', description: 'Controls whether players are allowed to damage other players.' },
	randomTickSpeed: { name: 'Random tick speed rate' },
	reducedDebugInfo: { name: 'Reduce debug info', description: 'Limits contents of debug screen.' },
	sendCommandFeedback: { name: 'Send command feedback' },
	showDeathMessages: { name: 'Show death messages' },
	snowAccumulationHeight: { name: 'Snow accumulation height', description: 'When it snows, layers of snow form on the ground up to at most this number of layers.' },
	spawnChunkRadius: { name: 'Spawn chunk radius', description: 'Amount of chunks that stay loaded around the overworld spawn position.' },
	spawnMonsters: { name: 'Spawn Monsters', description: 'Controls whether monsters naturally spawn.' },
	spawnRadius: { name: 'Respawn location radius', description: 'Controls the size of the area around the spawn point that players can spawn in.' },
	spawnerBlocksEnabled: { name: 'Enable Spawner Blocks' },
	spectatorsGenerateChunks: { name: 'Allow spectators to generate terrain' },
	tntExplodes: { name: 'Allow TNT to be activated and to explode' },
	tntExplosionDropDecay: { name: 'In TNT explosions, some blocks won\'t drop their loot', description: 'Some of the drops from blocks destroyed by explosions caused by TNT are lost in the explosion.' },
	universalAnger: { name: 'Universal anger', description: 'Angered neutral mobs attack any nearby player, not just the player that angered them. Works best if forgiveDeadPlayers is disabled.' },
	waterSourceConversion: { name: 'Water converts to source', description: 'When flowing water is surrounded on two sides by water sources, it converts into a source.' },
	advance_time: { name: 'Advance time of day' },
	advance_weather: { name: 'Update weather' },
	allow_entering_nether_using_portals: { name: 'Allow Nether', description: 'Controls whether players are allowed to enter the Nether.' },
	block_drops: { name: 'Drop blocks', description: 'Controls resource drops from blocks, including experience orbs.' },
	block_explosion_drop_decay: { name: 'In block interaction explosions, some blocks won\'t drop their loot', description: 'Some of the drops from blocks destroyed by explosions caused by block interactions are lost in the explosion.' },
	command_block_output: { name: 'Broadcast command block output' },
	command_blocks_work: { name: 'Enable Command Blocks' },
	drowning_damage: { name: 'Deal drowning damage' },
	elytra_movement_check: { name: 'Do elytra movement check' },
	ender_pearls_vanish_on_death: { name: 'Thrown Ender Pearls vanish on death', description: 'Whether Ender Pearls thrown by a player vanish when that player dies.' },
	entity_drops: { name: 'Drop entity equipment', description: 'Controls drops from Minecarts (including inventories), Item Frames, Boats, etc.' },
	fall_damage: { name: 'Deal fall damage' },
	fire_damage: { name: 'Deal fire damage' },
	fire_spread_radius_around_player: { name: 'Fire spread radius', description: 'The radius in blocks around a player in which fire can spread.' },
	forgive_dead_players: { name: 'Forgive dead players', description: 'Angered neutral mobs stop being angry when the targeted player dies nearby.' },
	freeze_damage: { name: 'Deal freeze damage' },
	global_sound_events: { name: 'Global sound events', description: 'When certain game events happen, like a boss spawning, the sound is heard everywhere.' },
	immediate_respawn: { name: 'Respawn immediately' },
	keep_inventory: { name: 'Keep inventory after death' },
	lava_source_conversion: { name: 'Lava converts to source', description: 'When flowing lava is surrounded on two sides by lava sources, it converts into a source.' },
	limited_crafting: { name: 'Require recipe for crafting', description: 'If enabled, players will be able to craft only unlocked recipes.' },
	locator_bar: { name: 'Enable player Locator Bar', description: 'When enabled, a bar is shown on the screen to indicate the direction of players.' },
	log_admin_commands: { name: 'Broadcast admin commands' },
	max_block_modifications: { name: 'Command modification block limit', description: 'The number of blocks that can be changed at once by one command, such as fill or clone.' },
	max_command_forks: { name: 'Command context limit', description: 'Maximum number of contexts that can be used by commands like \'execute as\'.' },
	max_command_sequence_length: { name: 'Command chain size limit', description: 'Applies to command block chains and functions.' },
	max_entity_cramming: { name: 'Entity cramming threshold' },
	max_snow_accumulation_height: { name: 'Snow accumulation height', description: 'When it snows, layers of snow form on the ground up to at most this number of layers.' },
	mob_drops: { name: 'Drop mob loot', description: 'Controls resource drops from mobs, including experience orbs.' },
	mob_explosion_drop_decay: { name: 'In mob explosions, some blocks won\'t drop their loot', description: 'Some of the drops from blocks destroyed by explosions caused by mobs are lost in the explosion.' },
	mob_griefing: { name: 'Allow destructive mob actions' },
	natural_health_regeneration: { name: 'Regenerate health' },
	player_movement_check: { name: 'Do player movement check' },
	players_nether_portal_creative_delay: { name: 'Player\'s Nether Portal delay in creative mode', description: 'Time (in ticks) that a creative mode player needs to stand in a Nether Portal before changing dimensions.' },
	players_nether_portal_default_delay: { name: 'Player\'s Nether Portal delay in non-creative mode', description: 'Time (in ticks) that a non-creative mode player needs to stand in a Nether Portal before changing dimensions.' },
	players_sleeping_percentage: { name: 'Sleep percentage', description: 'The percentage of players who must be sleeping to skip the night.' },
	projectiles_can_break_blocks: { name: 'Projectiles can break blocks', description: 'Controls whether impact projectiles will destroy blocks that are destructible by them.' },
	raids: { name: 'Do raids' },
	random_tick_speed: { name: 'Random tick speed rate' },
	reduced_debug_info: { name: 'Reduce debug info', description: 'Limits contents of debug screen.' },
	respawn_radius: { name: 'Respawn location radius', description: 'Controls the size of the area around the spawn point that players can spawn in.' },
	send_command_feedback: { name: 'Send command feedback' },
	show_advancement_messages: { name: 'Announce advancements' },
	show_death_messages: { name: 'Show death messages' },
	spawn_mobs: { name: 'Spawn mobs', description: 'Some entities might have separate rules.' },
	spawn_monsters: { name: 'Spawn Monsters', description: 'Controls whether monsters naturally spawn.' },
	spawn_patrols: { name: 'Spawn pillager patrols' },
	spawn_phantoms: { name: 'Spawn phantoms' },
	spawn_wandering_traders: { name: 'Spawn Wandering Traders' },
	spawn_wardens: { name: 'Spawn Wardens' },
	spawner_blocks_work: { name: 'Enable Spawner Blocks' },
	spectators_generate_chunks: { name: 'Allow spectators to generate terrain' },
	spread_vines: { name: 'Vines spread', description: 'Controls whether the Vines block spreads randomly to adjacent blocks. Does not affect other types of vine blocks such as Weeping Vines, Twisting Vines, etc.' },
	tnt_explodes: { name: 'Allow TNT to be activated and to explode' },
	tnt_explosion_drop_decay: { name: 'In TNT explosions, some blocks won\'t drop their loot', description: 'Some of the drops from blocks destroyed by explosions caused by TNT are lost in the explosion.' },
	universal_anger: { name: 'Universal anger', description: 'Angered neutral mobs attack any nearby player, not just the player that angered them. Works best if forgiveDeadPlayers is disabled.' },
	water_source_conversion: { name: 'Water converts to source', description: 'When flowing water is surrounded on two sides by water sources, it converts into a source.' }
};

/**
 * The rules set by a number, as fresh worlds of 1.12.2, 1.21.1, 1.21.11 and 26.3 wrote them
 * (2026-11-05): nothing in the game shows them. An on or off rule needs none: its switch says it.
 */
const NUMBER_RULE_DEFAULTS: Record<string, number> = {
	commandModificationBlockLimit: 32768,
	fire_spread_radius_around_player: 128,
	max_block_modifications: 32768,
	max_command_forks: 65536,
	max_command_sequence_length: 65536,
	max_entity_cramming: 24,
	max_snow_accumulation_height: 1,
	maxCommandChainLength: 65536,
	maxCommandForkCount: 65536,
	maxEntityCramming: 24,
	players_nether_portal_creative_delay: 0,
	players_nether_portal_default_delay: 80,
	players_sleeping_percentage: 100,
	playersNetherPortalCreativeDelay: 1,
	playersNetherPortalDefaultDelay: 80,
	playersSleepingPercentage: 100,
	random_tick_speed: 3,
	randomTickSpeed: 3,
	respawn_radius: 10,
	snowAccumulationHeight: 1,
	spawnChunkRadius: 2,
	spawnRadius: 10
};

/** keepInventory, spawn_monsters, minecraft:pvp -> "Keep inventory", "Spawn monsters", "Pvp". */
export function ruleLabel(key: string): string {
	const bare = key.replace(/^minecraft:/, '');
	const known = VANILLA_GAME_RULES[bare];
	if (known) return known.name;
	const words = bare.replace(/[_:.-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export const ruleDescription = (key: string): string | null => VANILLA_GAME_RULES[key.replace(/^minecraft:/, '')]?.description ?? null;

export const ruleDefault = (key: string): number | null => NUMBER_RULE_DEFAULTS[key.replace(/^minecraft:/, '')] ?? null;

/** Whether this key is one of Minecraft's own rules (else a mod's, or one the table does not know). */
export const isVanillaRule = (key: string): boolean => key.replace(/^minecraft:/, '') in VANILLA_GAME_RULES;
