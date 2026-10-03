import { totalmem } from 'node:os';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';
import { getPreset } from './jvm-presets';
import { defaultProperties, PROPERTY_SCHEMA, type PropertyField } from './properties';

/**
 * What a new instance starts with, editable on the global settings page.
 * Stored as one JSON row in `settings`; anything missing or invalid there
 * falls back to the built-in value, so a stored row from an older version
 * (or a hand-edited one) can never produce a broken instance.
 *
 * Only new instances read these. Existing ones keep their own settings.
 */

const SETTINGS_KEY = 'instance.defaults';

export type RestartSettings = {
	/** none | interval | daily */
	restartSchedule: string;
	restartIntervalHours: number;
	/** HH:MM, server-local time */
	restartDailyTime: string;
	restartWarnMinutes: number;
	restartSkipIfPlayers: boolean;
	autoRestartOnCrash: boolean;
	crashRestartLimit: number;
	crashRestartWindowSec: number;
};

export type ConsoleSettings = {
	consoleBacklogLines: number;
	consoleBufferLines: number;
};

export type InstanceDefaults = {
	/** Null: suggested from the machine's RAM each time (suggestedMaxMb). */
	memoryMaxMb: number | null;
	memoryMinMb: number;
	/** JVM preset id; a deleted preset falls back to the built-in default. */
	jvmPreset: string;
	restarts: RestartSettings;
	console: ConsoleSettings;
	/** server.properties values for DEFAULTABLE_PROPERTIES keys, every key present. */
	properties: Record<string, string>;
};

const DEFAULT_PRESET = 'aikar';

/**
 * server.properties keys that make sense as a default for every server.
 * Left out: what MineShell assigns per instance (ports, RCON, the MOTD that
 * starts as the server's name) and the world's identity (folder, seed, and a
 * world type whose valid values depend on the Minecraft version).
 */
const PER_INSTANCE_PROPERTIES = new Set([
	'motd',
	'server-port',
	'enable-rcon',
	'rcon.port',
	'rcon.password',
	'level-name',
	'level-seed',
	'level-type'
]);

export const DEFAULTABLE_PROPERTIES: PropertyField[] = PROPERTY_SCHEMA.filter(
	(f) => !PER_INSTANCE_PROPERTIES.has(f.key)
);

/** The built-in game settings, from the same function that writes a new server's file. */
function builtInProperties(): Record<string, string> {
	const all = defaultProperties({ port: 25565, rconPort: 25575, rconPassword: '', motd: '', minecraftVersion: '' });
	return Object.fromEntries(DEFAULTABLE_PROPERTIES.map((f) => [f.key, all[f.key] ?? '']));
}

export const BUILT_IN_DEFAULTS: InstanceDefaults = {
	memoryMaxMb: null,
	memoryMinMb: 1024,
	jvmPreset: DEFAULT_PRESET,
	restarts: {
		restartSchedule: 'none',
		restartIntervalHours: 6,
		restartDailyTime: '05:00',
		restartWarnMinutes: 5,
		restartSkipIfPlayers: false,
		autoRestartOnCrash: true,
		crashRestartLimit: 5,
		crashRestartWindowSec: 600
	},
	console: { consoleBacklogLines: 300, consoleBufferLines: 2000 },
	properties: builtInProperties()
};

/** Total RAM minus 2 GB for the OS and MineShell, between 1 and 16 GB. */
export function suggestedMaxMb(): number {
	const totalMb = Math.floor(totalmem() / (1024 * 1024));
	return Math.max(1024, Math.min(totalMb - 2048, 16384));
}

// ------------------------------------------------------------- validation ---

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

const SCHEDULES = ['none', 'interval', 'daily'];

/** Ranges match the inputs on the settings pages. */
export function cleanRestarts(input: Partial<Record<keyof RestartSettings, unknown>>, fallback: RestartSettings): RestartSettings {
	const time = String(input.restartDailyTime ?? '');
	return {
		restartSchedule: SCHEDULES.includes(String(input.restartSchedule)) ? String(input.restartSchedule) : fallback.restartSchedule,
		restartIntervalHours: clampInt(input.restartIntervalHours, 1, 168, fallback.restartIntervalHours),
		restartDailyTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : fallback.restartDailyTime,
		restartWarnMinutes: clampInt(input.restartWarnMinutes, 0, 60, fallback.restartWarnMinutes),
		restartSkipIfPlayers: typeof input.restartSkipIfPlayers === 'boolean' ? input.restartSkipIfPlayers : fallback.restartSkipIfPlayers,
		autoRestartOnCrash: typeof input.autoRestartOnCrash === 'boolean' ? input.autoRestartOnCrash : fallback.autoRestartOnCrash,
		crashRestartLimit: clampInt(input.crashRestartLimit, 1, 50, fallback.crashRestartLimit),
		crashRestartWindowSec: clampInt(input.crashRestartWindowSec, 60, 86400, fallback.crashRestartWindowSec)
	};
}

export function cleanConsole(input: Partial<Record<keyof ConsoleSettings, unknown>>, fallback: ConsoleSettings): ConsoleSettings {
	return {
		consoleBacklogLines: clampInt(input.consoleBacklogLines, 0, 10000, fallback.consoleBacklogLines),
		consoleBufferLines: clampInt(input.consoleBufferLines, 100, 100000, fallback.consoleBufferLines)
	};
}

/** Restart fields as the settings forms post them (checkboxes are absent when off). */
export function restartsFromForm(form: FormData, fallback: RestartSettings): RestartSettings {
	return cleanRestarts(
		{
			restartSchedule: form.get('restartSchedule'),
			restartIntervalHours: form.get('restartIntervalHours'),
			restartDailyTime: form.get('restartDailyTime'),
			restartWarnMinutes: form.get('restartWarnMinutes'),
			restartSkipIfPlayers: form.get('restartSkipIfPlayers') === 'on',
			autoRestartOnCrash: form.get('autoRestartOnCrash') === 'on',
			crashRestartLimit: form.get('crashRestartLimit'),
			crashRestartWindowSec: form.get('crashRestartWindowSec')
		},
		fallback
	);
}

export function consoleFromForm(form: FormData, fallback: ConsoleSettings): ConsoleSettings {
	return cleanConsole(
		{ consoleBacklogLines: form.get('consoleBacklogLines'), consoleBufferLines: form.get('consoleBufferLines') },
		fallback
	);
}

function cleanProperties(input: unknown): Record<string, string> {
	const stored = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	const out = { ...BUILT_IN_DEFAULTS.properties };
	for (const field of DEFAULTABLE_PROPERTIES) {
		const value = stored[field.key];
		if (typeof value !== 'string') continue;
		if (field.type === 'boolean' && value !== 'true' && value !== 'false') continue;
		if (field.type === 'select' && !field.options?.some((o) => o.value === value)) continue;
		if (field.type === 'number') {
			if (!/^-?\d+$/.test(value)) continue;
			out[field.key] = String(clampInt(value, field.min ?? -Infinity, field.max ?? Infinity, Number(out[field.key])));
			continue;
		}
		out[field.key] = value;
	}
	return out;
}

function clean(input: Partial<InstanceDefaults>): InstanceDefaults {
	const base = BUILT_IN_DEFAULTS;
	const memoryMaxMb = input.memoryMaxMb === null || input.memoryMaxMb === undefined ? null : clampInt(input.memoryMaxMb, 512, 1048576, 4096);
	const memoryMinMb = clampInt(input.memoryMinMb, 256, 1048576, base.memoryMinMb);
	return {
		memoryMaxMb,
		memoryMinMb: memoryMaxMb === null ? memoryMinMb : Math.min(memoryMinMb, memoryMaxMb),
		jvmPreset: typeof input.jvmPreset === 'string' && input.jvmPreset ? input.jvmPreset : base.jvmPreset,
		restarts: cleanRestarts((input.restarts ?? {}) as Record<string, unknown>, base.restarts),
		console: cleanConsole((input.console ?? {}) as Record<string, unknown>, base.console),
		properties: cleanProperties(input.properties)
	};
}

// ---------------------------------------------------------------- storage ---

export function getInstanceDefaults(): InstanceDefaults {
	const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
	let stored: Partial<InstanceDefaults> = {};
	try {
		if (row?.value) stored = JSON.parse(row.value);
	} catch {
		/* a broken row reads as no row */
	}
	const defaults = clean(stored);
	if (!getPreset(defaults.jvmPreset)) defaults.jvmPreset = DEFAULT_PRESET;
	return defaults;
}

/**
 * Stores the defaults. Game settings equal to the built-in value are not
 * stored, so a later change to a built-in default still reaches users who
 * never touched that setting.
 */
export function setInstanceDefaults(input: Partial<InstanceDefaults>): InstanceDefaults {
	const defaults = clean(input);
	const properties = Object.fromEntries(
		Object.entries(defaults.properties).filter(([key, value]) => BUILT_IN_DEFAULTS.properties[key] !== value)
	);
	const value = JSON.stringify({ ...defaults, properties });
	db.insert(settings)
		.values({ key: SETTINGS_KEY, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } })
		.run();
	return getInstanceDefaults();
}

export function resetInstanceDefaults(): void {
	db.delete(settings).where(eq(settings.key, SETTINGS_KEY)).run();
}

/** The maximum memory a new instance is offered: the stored value, or the RAM-based suggestion. */
export function defaultMaxMb(defaults = getInstanceDefaults()): number {
	return defaults.memoryMaxMb ?? suggestedMaxMb();
}
