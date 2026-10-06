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
	{ key: 'allow-nether', label: 'Allow the Nether', type: 'boolean', group: 'World' },
	{ key: 'spawn-protection', label: 'Spawn protection radius', type: 'number', min: 0, max: 256, group: 'World' },

	{ key: 'max-players', label: 'Player slots', type: 'number', min: 1, max: 2000, group: 'Players' },
	{ key: 'white-list', label: 'Whitelist only', type: 'boolean', group: 'Players', help: 'When on, only players on the whitelist can join.' },
	{ key: 'enforce-whitelist', label: 'Kick players removed from the whitelist', type: 'boolean', group: 'Players' },
	{ key: 'pvp', label: 'Player versus player', type: 'boolean', group: 'Players' },
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
	{ key: 'spawn-monsters', label: 'Spawn monsters', type: 'boolean', group: 'Gameplay' },
	{ key: 'enable-command-block', label: 'Enable command blocks', type: 'boolean', group: 'Gameplay' },

	{ key: 'view-distance', label: 'View distance (chunks)', type: 'number', min: 2, max: 32, group: 'Performance' },
	{ key: 'simulation-distance', label: 'Simulation distance (chunks)', type: 'number', min: 2, max: 32, group: 'Performance' },
	{ key: 'max-tick-time', label: 'Watchdog tick limit (ms)', type: 'number', min: -1, max: 600000, group: 'Performance', help: '-1 disables the watchdog. Useful on heavy modpacks that stall during chunk generation.' },
	{ key: 'sync-chunk-writes', label: 'Synchronous chunk writes', type: 'boolean', group: 'Performance', help: 'Off is faster; on is safer against sudden power loss.' },
	{ key: 'network-compression-threshold', label: 'Network compression threshold', type: 'number', min: -1, max: 65535, group: 'Performance' },
	{ key: 'entity-broadcast-range-percentage', label: 'Entity broadcast range (%)', type: 'number', min: 10, max: 1000, group: 'Performance' }
];

const SCHEMA_KEYS = new Set(PROPERTY_SCHEMA.map((f) => f.key));

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

export type ParsedProperties = {
	values: Record<string, string>;
	/** Keys present in the file that MineShell has no typed field for. */
	extraKeys: string[];
};

export function parseProperties(text: string): ParsedProperties {
	const values: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
		const idx = trimmed.indexOf('=');
		if (idx < 0) continue;
		values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1);
	}
	const extraKeys = Object.keys(values)
		.filter((k) => !SCHEMA_KEYS.has(k))
		.sort();
	return { values, extraKeys };
}

/**
 * Comments and original ordering are not preserved - that was an explicit call,
 * since the file is regenerated by the server anyway. Keys are sorted so diffs
 * stay readable.
 */
export function serialiseProperties(values: Record<string, string>): string {
	const header = `#Minecraft server properties\n#Last written by MineShell ${new Date().toISOString()}\n`;
	const body = Object.keys(values)
		.sort()
		.map((k) => `${k}=${values[k] ?? ''}`)
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
