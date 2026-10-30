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
};

export const PROPERTY_GROUPS = ['World', 'Players', 'Gameplay', 'Performance', 'Network'] as const;

/** Add a row here and it appears in the UI. Nothing else needs to change. */
export const PROPERTY_SCHEMA: PropertyField[] = [
	{ key: 'motd', label: 'Server description', type: 'textarea', group: 'Network', help: 'Shown in the multiplayer list.' },
	{ key: 'server-port', label: 'Port', type: 'number', min: 1, max: 65535, group: 'Network', restartRequired: true },
	{ key: 'server-ip', label: 'Bind address', type: 'text', group: 'Network', help: 'Leave blank to listen on every interface.', restartRequired: true },
	{ key: 'online-mode', label: 'Verify accounts with Mojang', type: 'boolean', group: 'Network', help: 'Turning this off lets cracked clients join. Only do it behind a whitelist on a private network.' },
	{ key: 'enable-rcon', label: 'Enable RCON', type: 'boolean', group: 'Network', help: 'MineShell sends console commands over RCON. Turning it off makes the console read-only.', restartRequired: true },
	{ key: 'rcon.port', label: 'RCON port', type: 'number', min: 1, max: 65535, group: 'Network', restartRequired: true },
	{ key: 'rcon.password', label: 'RCON password', type: 'text', group: 'Network', help: "Managed by MineShell. Change it in the server's Settings (Network) instead." },
	{ key: 'enable-query', label: 'Enable query protocol', type: 'boolean', group: 'Network' },

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
	{ key: 'generate-structures', label: 'Generate structures', type: 'boolean', group: 'World' },
	{ key: 'allow-nether', label: 'Allow the Nether', type: 'boolean', group: 'World', help: 'Minecraft 1.21.8 and older; a game rule from 1.21.9.', until: '1.21.8' },
	{ key: 'spawn-protection', label: 'Spawn protection radius', type: 'number', min: 0, max: 256, group: 'World' },

	{ key: 'max-players', label: 'Player slots', type: 'number', min: 1, max: 2000, group: 'Players' },
	{ key: 'white-list', label: 'Whitelist only', type: 'boolean', group: 'Players', help: 'When on, only players on the whitelist can join.' },
	{ key: 'enforce-whitelist', label: 'Kick players removed from the whitelist', type: 'boolean', group: 'Players' },
	{ key: 'pvp', label: 'Player versus player', type: 'boolean', group: 'Players', help: 'Minecraft 1.21.8 and older; a game rule from 1.21.9.', until: '1.21.8' },
	{ key: 'player-idle-timeout', label: 'Idle kick after (minutes)', type: 'number', min: 0, max: 600, group: 'Players', help: '0 never kicks.' },
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
	{ key: 'spawn-monsters', label: 'Spawn monsters', type: 'boolean', group: 'Gameplay', help: 'Minecraft 1.21.8 and older; a game rule from 1.21.9.', until: '1.21.8' },
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
		help: 'Stops ticking the world once nobody has been online this long; the next player to join wakes it. 0 never pauses. Minecraft 1.21.2 and newer.',
		since: '1.21.2'
	},
	{ key: 'sync-chunk-writes', label: 'Synchronous chunk writes', type: 'boolean', group: 'Performance', help: 'Off is faster; on is safer against sudden power loss.' },
	{ key: 'network-compression-threshold', label: 'Network compression threshold', type: 'number', min: -1, max: 65535, group: 'Performance' },
	{ key: 'entity-broadcast-range-percentage', label: 'Entity broadcast range (%)', type: 'number', min: 10, max: 1000, group: 'Performance' }
];

const SCHEMA_KEYS = new Set(PROPERTY_SCHEMA.map((f) => f.key));

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
			values[field.key] = String(form.get(field.key) ?? '');
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

		// Higher than vanilla's own default (20) since anyone reaching for a
		// server manager is usually planning for more than a couple of friends.
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
