import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';

/**
 * JVM flags were previously generated once at instance creation and then left
 * as free text, so the starting point could never be recovered after an edit.
 * Presets make the built-in sets reselectable and let a tuned set be saved and
 * reused across instances.
 *
 * Memory flags are deliberately not part of a preset body: -Xms/-Xmx are
 * derived from the instance's memory settings and rewritten on every save, so
 * baking them into a preset would just create two places that disagree.
 */

export type JvmPreset = {
	id: string;
	name: string;
	description: string;
	/** Flags excluding -Xms/-Xmx, which are applied from the memory fields. */
	flags: string;
	builtIn: boolean;
};

const SETTINGS_KEY = 'jvm.customPresets';

export const BUILT_IN_PRESETS: JvmPreset[] = [
	{
		id: 'aikar',
		name: 'Aikar (recommended)',
		description:
			'The widely used G1GC tuning for modded servers. A good default for anything from 4GB up.',
		flags: [
			'-XX:+UseG1GC',
			'-XX:+ParallelRefProcEnabled',
			'-XX:MaxGCPauseMillis=200',
			'-XX:+UnlockExperimentalVMOptions',
			'-XX:+DisableExplicitGC',
			'-XX:+AlwaysPreTouch',
			'-XX:G1HeapWastePercent=5',
			'-XX:G1MixedGCCountTarget=4',
			'-XX:G1MixedGCLiveThresholdPercent=90',
			'-XX:G1RSetUpdatingPauseTimePercent=5',
			'-XX:SurvivorRatio=32',
			'-XX:+PerfDisableSharedMem',
			'-XX:MaxTenuringThreshold=1',
			'-Dusing.aikars.flags=https://mcflags.emc.gs',
			'-Daikars.new.flags=true'
		].join(' '),
		builtIn: true
	},
	{
		id: 'aikar-large',
		name: 'Aikar (12GB or more)',
		description:
			"Aikar's own adjustments for large heaps: bigger regions and a higher occupancy target.",
		flags: [
			'-XX:+UseG1GC',
			'-XX:+ParallelRefProcEnabled',
			'-XX:MaxGCPauseMillis=200',
			'-XX:+UnlockExperimentalVMOptions',
			'-XX:+DisableExplicitGC',
			'-XX:+AlwaysPreTouch',
			'-XX:G1NewSizePercent=40',
			'-XX:G1MaxNewSizePercent=50',
			'-XX:G1HeapRegionSize=16M',
			'-XX:G1ReservePercent=15',
			'-XX:G1HeapWastePercent=5',
			'-XX:G1MixedGCCountTarget=4',
			'-XX:InitiatingHeapOccupancyPercent=20',
			'-XX:G1MixedGCLiveThresholdPercent=90',
			'-XX:G1RSetUpdatingPauseTimePercent=5',
			'-XX:SurvivorRatio=32',
			'-XX:+PerfDisableSharedMem',
			'-XX:MaxTenuringThreshold=1',
			'-Dusing.aikars.flags=https://mcflags.emc.gs',
			'-Daikars.new.flags=true'
		].join(' '),
		builtIn: true
	},
	{
		id: 'zgc',
		name: 'ZGC (low pause, Java 17+)',
		description:
			'Trades throughput for very short pauses. Worth trying on a big heap if tick lag spikes matter more than raw performance.',
		flags: [
			'-XX:+UseZGC',
			'-XX:+ZGenerational',
			'-XX:+AlwaysPreTouch',
			'-XX:+DisableExplicitGC',
			'-XX:+PerfDisableSharedMem'
		].join(' '),
		builtIn: true
	},
	{
		id: 'minimal',
		name: 'Minimal',
		description:
			'No tuning beyond the memory settings. Use when a pack ships its own flags or you want a clean baseline.',
		flags: '',
		builtIn: true
	}
];

type StoredPreset = { id: string; name: string; description: string; flags: string };

function readCustom(): StoredPreset[] {
	const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
	if (!row?.value) return [];
	try {
		const parsed = JSON.parse(row.value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeCustom(presets: StoredPreset[]): void {
	const value = JSON.stringify(presets);
	db.insert(settings)
		.values({ key: SETTINGS_KEY, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } })
		.run();
}

export function listPresets(): JvmPreset[] {
	return [...BUILT_IN_PRESETS, ...readCustom().map((p) => ({ ...p, builtIn: false }))];
}

export function getPreset(id: string): JvmPreset | null {
	return listPresets().find((p) => p.id === id) ?? null;
}

/** Strips memory flags so a saved preset never fights the memory fields. */
export function stripMemoryFlags(flags: string): string {
	return flags
		.replace(/-Xm[sx]\S+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Flags that only exist on Java 8 and make newer JVMs refuse to start
 * ("Unrecognized VM option"). Old Forge packs tend to carry them, and they
 * have to go when such an instance moves to a modern-Java loader.
 */
const JAVA8_ONLY_FLAGS = [
	/^-XX:[+-]UseConcMarkSweepGC$/,
	/^-XX:[+-]?CMS\S*$/,
	/^-XX:[+-]UseParNewGC$/,
	/^-XX:[+-]AggressiveOpts$/,
	/^-XX:[+-]UseFastAccessorMethods$/,
	/^-XX:[+-]UseCompressedStrings$/,
	/^-XX:[+-]UseSplitVerifier$/,
	/^-XX:(Max)?PermSize=\S+$/
];

export function stripJava8OnlyFlags(flags: string): { flags: string; removed: string[] } {
	const removed: string[] = [];
	const kept = flags
		.split(/\s+/)
		.filter(Boolean)
		.filter((flag) => {
			const legacy = JAVA8_ONLY_FLAGS.some((re) => re.test(flag));
			if (legacy) removed.push(flag);
			return !legacy;
		});
	return { flags: kept.join(' '), removed };
}

export function saveCustomPreset(name: string, flags: string): JvmPreset {
	const trimmed = name.trim();
    if (!trimmed) throw new Error('A preset needs a name.');

	const custom = readCustom();
	const id = `custom:${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
	if (BUILT_IN_PRESETS.some((p) => p.id === id)) {
		throw new Error('That name collides with a built-in preset. Pick another.');
	}

	const entry: StoredPreset = {
		id,
		name: trimmed,
		description: 'Saved from an instance.',
		flags: stripMemoryFlags(flags)
	};

	const next = custom.filter((p) => p.id !== id);
	next.push(entry);
	writeCustom(next);
	return { ...entry, builtIn: false };
}

export function deleteCustomPreset(id: string): void {
	writeCustom(readCustom().filter((p) => p.id !== id));
}

/** Builds a full argument string: memory flags first, then the preset body. */
export function composeJvmArgs(flags: string, minMb: number, maxMb: number): string {
	return `-Xms${minMb}M -Xmx${maxMb}M ${stripMemoryFlags(flags)}`.trim();
}
