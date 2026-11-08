import fs from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from './java';

/**
 * server.properties is a flat key=value file. MineShell renders a curated set of
 * keys as real inputs and drops everything else into an advanced section, so a
 * key MineShell has never heard of still round-trips instead of vanishing.
 */

export type PropertyField = {
	key: string;
	label: string;
	help?: string;
	type: 'text' | 'number' | 'boolean' | 'select' | 'textarea';
	options?: { value: string; label: string }[];
	min?: number;
	max?: number;
	group: string;
	/** Changing this needs a restart to take effect. */
	restartRequired?: boolean;
	/** A number nudged a few steps either way (chunks): a notched slider between min and max. */
	slider?: { unit: string };
	/** The first Minecraft version that reads it; older servers do not get the field. */
	since?: string;
	/** The last Minecraft version that reads it; newer servers do not get the field. */
	until?: string;
	/**
	 * Minecraft's own value, shown while the file does not have the key yet: the server writes
	 * every key it reads on its first start, so before that (or before the first start on a
	 * newer version) a switch would show off and saving its section would write that.
	 */
	default?: string;
};

export const PROPERTY_GROUPS = ['World', 'Players', 'Gameplay', 'Performance', 'Network'] as const;

/** Add a row here and it appears in the UI. Nothing else needs to change. */
export const PROPERTY_SCHEMA: PropertyField[] = [
	{ key: 'motd', label: 'Server description', type: 'textarea', group: 'Network', help: 'Shown in the multiplayer list.' },
	{ key: 'server-port', label: 'Port', type: 'number', min: 1, max: 65535, group: 'Network', restartRequired: true },
	{ key: 'server-ip', label: 'Bind address', type: 'text', group: 'Network', help: 'Leave blank to listen on every interface.', restartRequired: true },
	{ key: 'online-mode', label: 'Verify accounts with Mojang', type: 'boolean', group: 'Network', help: 'Turning this off lets cracked clients join. Only do it behind a whitelist on a private network.', default: 'true' },
	{ key: 'enable-rcon', label: 'Enable RCON', type: 'boolean', group: 'Network', help: 'MineShell sends console commands over RCON. Turning it off makes the console read-only.', restartRequired: true },
	{ key: 'rcon.port', label: 'RCON port', type: 'number', min: 1, max: 65535, group: 'Network', restartRequired: true },
	{ key: 'rcon.password', label: 'RCON password', type: 'text', group: 'Network', help: "Managed by MineShell. Change it in the server's Settings (Network) instead." },
	{ key: 'enable-query', label: 'Enable query protocol', type: 'boolean', group: 'Network', help: 'Answers server list sites and status tools (GameSpy4) over UDP on the game port\'s number, which MineShell keeps query.port at.' },
	{
		key: 'enforce-secure-profile',
		label: 'Require signed chat',
		type: 'boolean',
		group: 'Network',
		help: 'Only lets in players whose chat Mojang signs. Turn it off when players use No Chat Reports or similar and cannot join. Does nothing with account verification off.',
		since: '1.19',
		default: 'true'
	},
	{ key: 'enable-status', label: 'Show in the multiplayer list', type: 'boolean', group: 'Network', help: 'Off, the list shows the server as unreachable; players can still join by its address.', since: '1.16', default: 'true' },
	{ key: 'hide-online-players', label: 'Hide who is online', type: 'boolean', group: 'Network', help: 'The multiplayer list shows how many are online, but not their names.', since: '1.18', default: 'false' },
	{
		key: 'rate-limit',
		label: 'Packet limit per second',
		type: 'number',
		min: 0,
		max: 100000,
		group: 'Network',
		help: 'Kicks a player whose game sends more packets a second than this. 0 is off; some mods send many and get players kicked by a low limit.',
		since: '1.16.2',
		default: '0'
	},
	{ key: 'accepts-transfers', label: 'Accept transferred players', type: 'boolean', group: 'Network', help: 'Lets another server send its players here with /transfer.', since: '1.20.5', default: 'false' },
	{ key: 'log-ips', label: 'Log players\' IP addresses', type: 'boolean', group: 'Network', help: 'Writes the address each player joins from into the log.', since: '1.20.2', default: 'true' },

	{ key: 'level-name', label: 'World folder', type: 'text', group: 'World', restartRequired: true },
	{ key: 'level-seed', label: 'World seed', type: 'text', group: 'World', help: 'Only used when the world is first generated.', restartRequired: true },
	{
		key: 'level-type',
		label: 'World type',
		type: 'select',
		group: 'World',
		options: [
			{ value: 'minecraft:normal', label: 'Normal' },
			{ value: 'minecraft:flat', label: 'Superflat' },
			{ value: 'minecraft:large_biomes', label: 'Large biomes' },
			{ value: 'minecraft:amplified', label: 'Amplified' },
			{ value: 'minecraft:single_biome_surface', label: 'Single biome' }
		],
		restartRequired: true
	},
	{
		key: 'generator-settings',
		label: 'Generator settings',
		type: 'text',
		group: 'World',
		help: 'Only used when the world is first generated: the superflat layers or a custom generator, as JSON from 1.13 (before, a superflat preset code). Blank is the world type\'s own.',
		since: '1.4.2',
		restartRequired: true
	},
	{
		key: 'initial-enabled-packs',
		label: 'Data packs enabled at first',
		type: 'text',
		group: 'World',
		help: 'Only used when the world is first generated: the data packs it starts with, by name, separated by commas. After that, the Data packs tab.',
		since: '1.19.3',
		default: 'vanilla',
		restartRequired: true
	},
	{
		key: 'initial-disabled-packs',
		label: 'Data packs disabled at first',
		type: 'text',
		group: 'World',
		help: 'Only used when the world is first generated: packs a mod or the server offers that it starts without.',
		since: '1.19.3',
		default: '',
		restartRequired: true
	},
	{ key: 'generate-structures', label: 'Generate structures', type: 'boolean', group: 'World', help: 'Villages, temples, strongholds and the like, in chunks generated from now on.', default: 'true' },
	{ key: 'allow-nether', label: 'Allow the Nether', type: 'boolean', group: 'World', help: 'Minecraft 1.21.8 and older; a game rule from 1.21.9.', until: '1.21.8', default: 'true' },
	{ key: 'spawn-protection', label: 'Spawn protection radius', type: 'number', min: 0, max: 256, group: 'World', help: 'Within this many blocks of the world spawn only operators can build (no protection while the server has no operators). 0 is off.' },

	{ key: 'max-players', label: 'Player slots', type: 'number', min: 1, max: 2000, group: 'Players' },
	{ key: 'white-list', label: 'Whitelist only', type: 'boolean', group: 'Players', help: 'When on, only players on the whitelist can join.' },
	{ key: 'enforce-whitelist', label: 'Kick players removed from the whitelist', type: 'boolean', group: 'Players' },
	{ key: 'pvp', label: 'Player versus player', type: 'boolean', group: 'Players', help: 'Minecraft 1.21.8 and older; a game rule from 1.21.9.', until: '1.21.8', default: 'true' },
	{ key: 'player-idle-timeout', label: 'Idle kick after (minutes)', type: 'number', min: 0, max: 600, group: 'Players', help: '0 never kicks.' },
	{
		key: 'chat-spam-threshold-seconds',
		label: 'Chat spam kick (seconds)',
		type: 'number',
		min: 0,
		max: 3600,
		group: 'Players',
		help: 'Each message counts a second, and the count goes down by one every second: a player is kicked when it reaches this, so 10 lets about ten quick messages through. 0 never kicks; operators are never kicked.',
		since: '26.2',
		default: '10'
	},
	{
		key: 'command-spam-threshold-seconds',
		label: 'Command spam kick (seconds)',
		type: 'number',
		min: 0,
		max: 3600,
		group: 'Players',
		help: 'The same for commands. Command blocks and mods that run commands for a player can count too.',
		since: '26.2',
		default: '10'
	},
	{
		key: 'op-permission-level',
		label: 'Operator permission level',
		type: 'select',
		group: 'Players',
		options: [
			{ value: '1', label: '1 - bypass spawn protection' },
			{ value: '2', label: '2 - singleplayer cheats' },
			{ value: '3', label: '3 - player management' },
			{ value: '4', label: '4 - full control' }
		]
	},

	{
		key: 'difficulty',
		label: 'Difficulty',
		type: 'select',
		group: 'Gameplay',
		options: [
			{ value: 'peaceful', label: 'Peaceful' },
			{ value: 'easy', label: 'Easy' },
			{ value: 'normal', label: 'Normal' },
			{ value: 'hard', label: 'Hard' }
		]
	},
	{
		key: 'gamemode',
		label: 'Default game mode',
		type: 'select',
		group: 'Gameplay',
		options: [
			{ value: 'survival', label: 'Survival' },
			{ value: 'creative', label: 'Creative' },
			{ value: 'adventure', label: 'Adventure' },
			{ value: 'spectator', label: 'Spectator' }
		]
	},
	{ key: 'force-gamemode', label: 'Force game mode on join', type: 'boolean', group: 'Gameplay' },
	{ key: 'hardcore', label: 'Hardcore', type: 'boolean', group: 'Gameplay' },
	{ key: 'allow-flight', label: 'Allow flight', type: 'boolean', group: 'Gameplay', help: 'Needed by most flight mods; otherwise players get kicked.' },
	{ key: 'spawn-monsters', label: 'Spawn monsters', type: 'boolean', group: 'Gameplay', help: 'Minecraft 1.21.8 and older; a game rule from 1.21.9.', until: '1.21.8', default: 'true' },
	{ key: 'enable-command-block', label: 'Enable command blocks', type: 'boolean', group: 'Gameplay', help: 'Minecraft 1.21.8 and older; a game rule from 1.21.9.', until: '1.21.8' },

	{ key: 'view-distance', label: 'View distance', type: 'number', min: 2, max: 32, slider: { unit: 'chunks' }, group: 'Performance' },
	{ key: 'simulation-distance', label: 'Simulation distance', type: 'number', min: 2, max: 32, slider: { unit: 'chunks' }, group: 'Performance' },
	{ key: 'max-tick-time', label: 'Watchdog tick limit (ms)', type: 'number', min: -1, max: 600000, group: 'Performance', help: '-1 disables the watchdog. Useful on heavy modpacks that stall during chunk generation.' },
	{
		key: 'pause-when-empty-seconds',
		label: 'Pause when empty after (seconds)',
		type: 'number',
		min: 0,
		max: 86400,
		group: 'Performance',
		help: 'Stops ticking the world once nobody has been online this long; the next player to join wakes it. 0 never pauses.',
		since: '1.21.2'
	},
	{ key: 'sync-chunk-writes', label: 'Synchronous chunk writes', type: 'boolean', group: 'Performance', help: 'Off is faster; on is safer against sudden power loss.', default: 'true' },
	{
		key: 'region-file-compression',
		label: 'Chunk compression',
		type: 'select',
		group: 'Performance',
		options: [
			{ value: 'deflate', label: 'Zlib (default)' },
			{ value: 'lz4', label: 'LZ4: quicker, larger files' },
			{ value: 'none', label: 'None: largest files' }
		],
		help: 'For chunks saved from now on; the ones already saved keep theirs, and the world reads both. Minecraft before 1.20.5 cannot read LZ4 chunks.',
		since: '1.20.5',
		default: 'deflate',
		restartRequired: true
	},
	{ key: 'network-compression-threshold', label: 'Network compression threshold', type: 'number', min: -1, max: 65535, group: 'Performance', help: 'Packets over this many bytes are compressed. -1 is off, good on a LAN; lower saves bandwidth and costs CPU.' },
	{ key: 'entity-broadcast-range-percentage', label: 'Entity broadcast range (%)', type: 'number', min: 10, max: 1000, group: 'Performance', help: 'How far away players are sent entities, as a share of the normal distance. Lower saves bandwidth and the players\' frame rate on busy servers.' }
];

const SCHEMA_KEYS = new Set(PROPERTY_SCHEMA.map((f) => f.key));

const MANAGEMENT_DANGER = 'a program holding the secret can make players operators, ban, and change the whitelist and settings. Only for a tool you run yourself, never on an address others reach.';

/**
 * Minecraft's own keys that have no control, each with what it does, for Other keys: there a
 * key without a note is then plainly a mod's or the pack's. Every key a vanilla server read
 * from 1.2.5 to 26.3 is either here, in the schema or managed (the server jars' strings and
 * mc-probe.mjs, 2026-11-03).
 */
const KEY_NOTES: Record<string, string> = {
	'max-world-size': 'How far from 0,0 the world reaches, in blocks: set beside the border under World > Game rules.',
	'broadcast-console-to-ops': 'Operators see commands typed into the server console in their chat.',
	'broadcast-rcon-to-ops': "The same for commands sent over RCON. MineShell's new servers have it on, so operators see what is sent from MineShell's console.",
	'enable-code-of-conduct': "Shows joining players the code of conduct in the server's codeofconduct folder, one text file per language. Minecraft 1.21.9 and newer.",
	'bug-report-link': "A page players are sent to from the game's bug report button.",
	'function-permission-level': 'The permission level data pack functions run with (2 by default).',
	'max-chained-neighbor-updates': 'Stops a chain of block updates after this many, so a huge redstone build cannot freeze the server. Negative is no limit.',
	'use-native-transport': "Linux's faster network code (epoll) where the server can use it. Best left on.",
	'prevent-proxy-connections': 'Kicks players whose connection comes from another address than the one they signed in to Mojang from (a VPN or proxy).',
	'enable-jmx-monitoring': "Shows the server's tick times to Java monitoring tools (JMX), which also need JVM flags.",
	'text-filtering-config': "Realms' chat filtering; nothing on a server of your own.",
	'text-filtering-version': "Realms' chat filtering; nothing on a server of your own.",
	'management-server-enabled': `Minecraft's management API (1.21.9 and newer): ${MANAGEMENT_DANGER}`,
	'management-server-secret': `The management API's key: ${MANAGEMENT_DANGER}`,
	'management-server-host': 'The address the management API listens on; localhost keeps it to this machine.',
	'management-server-port': "The management API's port.",
	'management-server-allowed-origins': 'Web pages that may use the management API from a browser.',
	'management-server-tls-enabled': "Encrypts the management API's connections, with the keystore below.",
	'management-server-tls-keystore': "The certificate store for the management API's encrypted connections.",
	'management-server-tls-keystore-password': "The certificate store's password.",
	'status-heartbeat-interval': 'How often the management API sends its clients the server status, in seconds (0 never).',
	'resource-pack': 'The address of a resource pack players are offered when they join.',
	'resource-pack-sha1': "That pack's SHA-1, so players' games can tell when it changed.",
	'resource-pack-hash': "That pack's SHA-1, as Minecraft 1.8 called it.",
	'resource-pack-id': "That pack's id, so players' games keep it apart from other servers' packs.",
	'resource-pack-prompt': 'The text players are shown when asked to take that pack.',
	'require-resource-pack': 'On, players who turn the pack down are disconnected.',
	'texture-pack': 'A texture pack players are offered when they join. Minecraft 1.6.4 and older.',
	'previews-chat': 'Chat preview: the server shows how a message will look while it is typed. Minecraft 1.19 to 1.19.2.',
	'spawn-animals': 'Whether animals spawn. Minecraft 1.21.1 and older.',
	'spawn-npcs': 'Whether villagers spawn. Minecraft 1.21.1 and older.',
	'max-build-height': 'The highest players can build. Minecraft 1.16.5 and older.',
	'snooper-enabled': 'Sends Mojang anonymous usage data. Minecraft 1.17.1 and older.',
	'announce-player-achievements': 'Announces achievements in chat. Minecraft 1.11.2 and older; a game rule after.'
};

/** What a key under Other keys does: Minecraft's own have a note, others are a mod's or the pack's. */
export function propertyNote(key: string): { note: string; vanilla: boolean } {
	const note = KEY_NOTES[key] ?? (key.startsWith('management-server-') ? "Part of Minecraft's management API (1.21.9 and newer)." : undefined);
	return note ? { note, vanilla: true } : { note: "Not one of Minecraft's own keys: a mod's or the pack's.", vanilla: false };
}

/**
 * The fields a server on this Minecraft version reads (an unknown version gets them all).
 * 1.21.9 made `pvp`, `allow-nether`, `spawn-monsters` and `enable-command-block` game rules
 * and ignores the keys, also for a world made on 1.21.8 (tried with mc-probe.mjs).
 */
export function fieldsForVersion(fields: PropertyField[], minecraftVersion: string): PropertyField[] {
	const version = minecraftVersion.trim();
	if (!version) return fields;
	return fields.filter((f) => (!f.since || compareVersions(version, f.since) >= 0) && (!f.until || compareVersions(version, f.until) <= 0));
}

/**
 * The game rules 1.21.9 and newer read instead of the four keys above (1.21.11 renamed
 * them; `pvp` kept its name), for the console note; null where the keys still work.
 */
export function movedGameRules(minecraftVersion: string): string[] | null {
	const version = minecraftVersion.trim();
	if (!version || compareVersions(version, '1.21.9') < 0) return null;
	return compareVersions(version, '1.21.11') >= 0
		? ['pvp', 'spawn_monsters', 'allow_entering_nether_using_portals', 'command_blocks_work']
		: ['pvp', 'spawnMonsters', 'allowEnteringNetherUsingPortals', 'commandBlocksEnabled'];
}

/**
 * The guided form's values for `fields`. Unchecked boxes are absent from the
 * payload, so each checkbox posts a `present:<key>` marker to tell "off" from
 * "not on this form"; fields not on the form are left out of the result.
 */
export function propertiesFromForm(form: FormData, fields: PropertyField[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const field of fields) {
		if (field.type === 'boolean') {
			if (form.has(`present:${field.key}`)) values[field.key] = form.get(field.key) === 'on' ? 'true' : 'false';
		} else if (form.has(field.key)) {
			const value = String(form.get(field.key) ?? '');
			// A posted textarea's line breaks are \r\n, and the server sent the \r on to clients.
			values[field.key] = field.type === 'textarea' ? value.replace(/\r\n?/g, '\n') : value;
		}
	}
	return values;
}

/**
 * `level-type` changed format in 1.19: older versions want a bare keyword
 * (`DEFAULT`, `FLAT`, ...), 1.19+ wants a namespaced id (`minecraft:normal`,
 * ...). An unrecognised value doesn't crash the server - it just logs a
 * warning and silently falls back to normal terrain - but that means picking
 * "Superflat" on an old pack would appear to do nothing. The schema above
 * lists the modern options since most instances are 1.19+; these two
 * functions give the properties page a version-correct list and default
 * instead.
 */
const LEGACY_LEVEL_TYPES: Record<string, string> = {
	'minecraft:normal': 'DEFAULT',
	'minecraft:flat': 'FLAT',
	'minecraft:large_biomes': 'LARGEBIOMES',
	'minecraft:amplified': 'AMPLIFIED',
	'minecraft:single_biome_surface': 'BUFFET'
};

export function usesNamespacedLevelType(minecraftVersion: string): boolean {
	return compareVersions(minecraftVersion.trim(), '1.19') >= 0;
}

/** The correctly-formatted level-type options for this instance's Minecraft version. */
export function levelTypeOptionsFor(minecraftVersion: string): { value: string; label: string }[] {
	const modern = PROPERTY_SCHEMA.find((f) => f.key === 'level-type')?.options ?? [];
	if (usesNamespacedLevelType(minecraftVersion)) return modern;
	return modern.map((o) => ({ value: LEGACY_LEVEL_TYPES[o.value] ?? o.value, label: o.label }));
}

function defaultLevelType(minecraftVersion: string): string {
	return usesNamespacedLevelType(minecraftVersion) ? 'minecraft:normal' : 'DEFAULT';
}

/**
 * Up to 1.13.2 Minecraft reads `difficulty` and `gamemode` as numbers only: a name
 * (`difficulty=hard`) falls back to the default (Easy, Survival) without a word, and the
 * server writes the number back. 1.14 and newer read both and write the name (tried with
 * mc-probe.mjs on 1.12.2, 1.13.2, 1.14.4 and 26.3; Cleanroom 1.12 wrote numbers too). A
 * choice's number is its place in the schema's options.
 */
const NUMBERED_CHOICES = ['difficulty', 'gamemode'];

export function usesNamedChoices(minecraftVersion: string): boolean {
	const version = minecraftVersion.trim();
	return !version || compareVersions(version, '1.14') >= 0;
}

/** A difficulty or game mode, by name or number, as this version reads it; anything else as it is. */
export function choiceValueFor(key: string, value: string, minecraftVersion: string): string {
	if (!NUMBERED_CHOICES.includes(key)) return value;
	const names = PROPERTY_SCHEMA.find((f) => f.key === key)?.options?.map((o) => o.value) ?? [];
	const given = value.trim().toLowerCase();
	const index = /^\d+$/.test(given) ? Number(given) : names.indexOf(given);
	if (index < 0 || index >= names.length) return value;
	return usesNamedChoices(minecraftVersion) ? names[index] : String(index);
}

/** `values` with the difficulty and game mode as this version reads them. */
export function propertiesForVersion(values: Record<string, string>, minecraftVersion: string): Record<string, string> {
	const out = { ...values };
	for (const key of NUMBERED_CHOICES) if (Object.hasOwn(out, key)) out[key] = choiceValueFor(key, out[key], minecraftVersion);
	return out;
}

/** For a page of any version (the new-server defaults): the field's help says which versions read it. */
export function withVersionNote(field: PropertyField): PropertyField {
	if (!field.since) return field;
	return { ...field, help: `${field.help ? `${field.help} ` : ''}Minecraft ${field.since} and newer.` };
}

/**
 * A field as this version reads it: the level types and numbered choices in its format, and
 * no note on the versions it is for (only the defaults for new servers, of any version, need it).
 */
export function fieldForVersion(field: PropertyField, minecraftVersion: string): PropertyField {
	if (field.until && minecraftVersion.trim()) return { ...field, help: undefined };
	if (field.key === 'level-type') return { ...field, options: levelTypeOptionsFor(minecraftVersion) };
	if (!NUMBERED_CHOICES.includes(field.key)) return field;
	return { ...field, options: field.options?.map((o) => ({ ...o, value: choiceValueFor(field.key, o.value, minecraftVersion) })) };
}

/** `values` with Minecraft's own value for each of `fields` the file does not have yet. */
export function withFieldDefaults(values: Record<string, string>, fields: PropertyField[]): Record<string, string> {
	const out = { ...values };
	for (const field of fields) if (field.default !== undefined && !Object.hasOwn(out, field.key)) out[field.key] = field.default;
	return out;
}

export type ParsedProperties = {
	values: Record<string, string>;
	/** Keys present in the file that MineShell has no typed field for. */
	extraKeys: string[];
};

/**
 * A Java .properties file as `Properties.load` reads it: `=`, `:` or a space ends the
 * key, a backslash escapes the next character (`\:`, `\\`, `\uXXXX`, `\t`), and one at
 * a line's end carries the value on. Minecraft writes `motd=Home\: survival\!` and, up to
 * 1.12 at least, letters past ASCII as `\u00FC`; read as plain text they showed up as
 * such in Settings, and a `level-name` with a colon named a folder that is not there.
 * Trailing spaces are dropped (`pvp=true  ` is on), as before.
 */
export function readJavaProperties(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].replace(/^[ \t\f]+/, '');
		if (!line || line.startsWith('#') || line.startsWith('!')) continue;
		// An odd number of backslashes at the end joins the next line.
		while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, '');
		const m = line.match(/^((?:\\.|[^=:\s\\])*)[ \t\f]*[=:]?[ \t\f]*(.*?)\s*$/);
		if (!m || !m[1]) continue;
		values[unescapeJava(m[1])] = unescapeJava(m[2].replace(/(^|[^\\])((?:\\\\)*)\\$/, '$1$2'));
	}
	return values;
}

function unescapeJava(s: string): string {
	return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) =>
		c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c
	);
}

/**
 * A value or key as `Properties.store` would write it, so that Java reads back the
 * same text. Letters past ASCII become `\uXXXX` unless `unicode` keeps them: up to
 * 1.12 Minecraft reads the file as Latin-1, so a "Gemütlich" written as UTF-8 showed
 * "GemÃ¼tlich" in the server list. `:` `=` `#` `!` only need escaping in a key.
 */
function escapeJava(s: string, key: boolean, unicode: boolean): string {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		const code = c.charCodeAt(0);
		if (c === '\\') out += '\\\\';
		else if (c === '\t') out += '\\t';
		else if (c === '\n') out += '\\n';
		else if (c === '\r') out += '\\r';
		else if (c === '\f') out += '\\f';
		else if (c === ' ' && (key || i === 0)) out += '\\ ';
		else if (key && '=:#!'.includes(c)) out += `\\${c}`;
		else if (code < 0x20 || (code > 0x7e && !unicode)) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
		else out += c;
	}
	return out;
}

export function parseProperties(text: string): ParsedProperties {
	const values = readJavaProperties(text);
	const extraKeys = Object.keys(values)
		.filter((k) => !SCHEMA_KEYS.has(k))
		.sort();
	return { values, extraKeys };
}

/**
 * Comments and original ordering are not preserved - that was an explicit call,
 * since the file is regenerated by the server anyway. Keys are sorted so diffs
 * stay readable. `unicode` keeps letters past ASCII as they are, for the raw
 * editor; the file itself gets them escaped (escapeJava).
 */
export function serialiseProperties(values: Record<string, string>, { unicode = false } = {}): string {
	const header = `#Minecraft server properties\n#Last written by MineShell ${new Date().toISOString()}\n`;
	const body = Object.keys(values)
		.sort()
		.map((k) => `${escapeJava(k, true, unicode)}=${escapeJava(values[k] ?? '', false, unicode)}`)
		.join('\n');
	return `${header}${body}\n`;
}

export function propertiesPath(instancePath: string): string {
	return path.join(instancePath, 'server.properties');
}

export async function readProperties(instancePath: string): Promise<ParsedProperties> {
	try {
		const text = await fs.readFile(propertiesPath(instancePath), 'utf8');
		return parseProperties(text);
	} catch {
		return { values: {}, extraKeys: [] };
	}
}

export async function writeProperties(
	instancePath: string,
	values: Record<string, string>
): Promise<void> {
	await fs.writeFile(propertiesPath(instancePath), serialiseProperties(values), 'utf8');
}

/**
 * Rewrites the difficulty and game mode in the format this version reads, when they are
 * not: names written for a server before 1.14 (by MineShell up to 0.33.14, a pack, a
 * version change). Run before every start; the server would read them as its defaults.
 */
export async function matchPropertiesToVersion(instancePath: string, minecraftVersion: string): Promise<void> {
	// Newer versions read a number too, and write the name back themselves.
	if (usesNamedChoices(minecraftVersion)) return;
	const { values } = await readProperties(instancePath);
	const matched = propertiesForVersion(values, minecraftVersion);
	if (NUMBERED_CHOICES.some((k) => values[k] !== matched[k])) await writeProperties(instancePath, matched);
}

/** Merge a partial update into the file on disk without dropping unknown keys. */
export async function patchProperties(
	instancePath: string,
	patch: Record<string, string>
): Promise<Record<string, string>> {
	const { values } = await readProperties(instancePath);
	const merged = { ...values, ...patch };
	await writeProperties(instancePath, merged);
	return merged;
}

/** Sane starting file for a brand new instance. */
export function defaultProperties(opts: {
	port: number;
	rconPort: number;
	rconPassword: string;
	motd: string;
	minecraftVersion: string;
}): Record<string, string> {
	return {
		'server-port': String(opts.port),
		'query.port': String(opts.port),
		'enable-rcon': 'true',
		'rcon.port': String(opts.rconPort),
		'rcon.password': opts.rconPassword,
		'broadcast-rcon-to-ops': 'true',
		motd: opts.motd,
		'server-ip': '',
		'online-mode': 'true',
		'enable-query': 'false',

		'level-name': 'world',
		'level-seed': '',
		'level-type': defaultLevelType(opts.minecraftVersion),
		'generate-structures': 'true',
		'allow-nether': 'true',
		'spawn-protection': '0',

		// Lower than vanilla's own 20: most servers MineShell runs are for a group
		// of friends, and the slot count is what the server list shows them.
		'max-players': '10',
		'white-list': 'false',
		'enforce-whitelist': 'false',
		pvp: 'true',
		'player-idle-timeout': '0',
		'op-permission-level': '4',

		difficulty: 'normal',
		gamemode: 'survival',
		'force-gamemode': 'false',
		hardcore: 'false',
		'allow-flight': 'true',
		'spawn-monsters': 'true',
		'enable-command-block': 'false',

		'view-distance': '10',
		// Doesn't exist before 1.18; harmless if written for an older server,
		// since Minecraft ignores server.properties keys it doesn't recognise.
		'simulation-distance': '10',
		// Minecraft's own default from 1.21.2; older versions ignore the key.
		'pause-when-empty-seconds': '60',
		'max-tick-time': '60000',
		'sync-chunk-writes': 'true',
		'network-compression-threshold': '256',
		'entity-broadcast-range-percentage': '100'
	};
}

/**
 * Fills in schema keys that are missing from the file without touching
 * anything already present. Used after a modpack's own overrides/server.properties
 * has been copied in wholesale (a raw file replace) - the pack's own choices
 * always win, but a pack that ships an incomplete file (or none at all, in
 * which case every key here is already "missing" and gets filled) still ends
 * up with sane values instead of blanks in the guided editor.
 */
export async function fillPropertyDefaults(
	instancePath: string,
	defaults: Record<string, string>
): Promise<Record<string, string>> {
	const { values } = await readProperties(instancePath);
	const merged = { ...defaults, ...values };
	await writeProperties(instancePath, merged);
	return merged;
}
