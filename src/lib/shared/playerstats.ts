/**
 * Player statistics as the pages show them (lib/server/playerstats.ts reads
 * the files). Pure, no server imports.
 *
 * Every version's stats come in one shape: the game's categories (1.13+'s
 * names) of id -> number, with 1.12's flat `stat.*` keys mapped onto them and
 * its general stats onto 1.13+'s ids, so units and names are the same for both.
 */

export const STAT_CATEGORIES = ['custom', 'mined', 'crafted', 'used', 'broken', 'picked_up', 'dropped', 'killed', 'killed_by'] as const;
export type StatCategory = (typeof STAT_CATEGORIES)[number];
export type StatTable = Record<StatCategory, Record<string, number>>;

export const CATEGORY_LABELS: Record<StatCategory, string> = {
	custom: 'General',
	mined: 'Mined',
	crafted: 'Crafted',
	used: 'Used',
	broken: 'Broken',
	picked_up: 'Picked up',
	dropped: 'Dropped',
	killed: 'Mobs killed',
	killed_by: 'Killed by'
};

export type StatUnit = 'time' | 'distance' | 'damage' | 'count';

/** Vanilla general stats are stored in ticks, centimetres and tenths of a health point. */
export function statUnit(id: string): StatUnit {
	const [ns, path] = id.includes(':') ? id.split(':', 2) : ['minecraft', id];
	if (ns !== 'minecraft') return 'count';
	if (path.endsWith('_one_cm')) return 'distance';
	if (['play_time', 'total_world_time', 'time_since_death', 'time_since_rest', 'sneak_time'].includes(path)) return 'time';
	if (path.startsWith('damage_')) return 'damage';
	return 'count';
}

const count = (n: number, digits = 0) => n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** A span in ticks: seconds under an hour, minutes under a day, then days and hours. */
export function formatTicks(ticks: number): string {
	const total = Math.max(0, Math.round(ticks / 20));
	const d = Math.floor(total / 86400);
	const h = Math.floor((total % 86400) / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${s}s`;
	return `${s}s`;
}

/** Centimetres: cm under a metre, one decimal under 10 m and under 100 km. */
export function formatCm(cm: number): string {
	if (cm < 100) return `${Math.round(cm)} cm`;
	const m = cm / 100;
	if (m < 10) return `${count(m, 1)} m`;
	if (m < 1000) return `${Math.round(m)} m`;
	const km = m / 1000;
	return `${count(km, km < 100 ? 1 : 0)} km`;
}

/** Tenths of a health point, as hearts (two points each). */
export function formatDamage(tenths: number): string {
	const hearts = tenths / 20;
	return `${count(hearts, hearts < 100 ? 1 : 0)} ${hearts === 1 ? 'heart' : 'hearts'}`;
}

export function formatStat(value: number, unit: StatUnit): string {
	if (unit === 'time') return formatTicks(value);
	if (unit === 'distance') return formatCm(value);
	if (unit === 'damage') return formatDamage(value);
	return count(value);
}

/** The numbers at the top of a player's stats, and the leaderboard's first choices. */
export const HEADLINES: { id: string; label: string; unit: StatUnit }[] = [
	{ id: 'minecraft:play_time', label: 'Time played', unit: 'time' },
	{ id: 'minecraft:deaths', label: 'Deaths', unit: 'count' },
	{ id: 'minecraft:mob_kills', label: 'Mob kills', unit: 'count' },
	{ id: 'minecraft:player_kills', label: 'Player kills', unit: 'count' },
	{ id: 'total:distance', label: 'Distance travelled', unit: 'distance' },
	{ id: 'total:mined', label: 'Blocks mined', unit: 'count' },
	{ id: 'total:crafted', label: 'Items crafted', unit: 'count' },
	{ id: 'minecraft:damage_dealt', label: 'Damage dealt', unit: 'damage' },
	{ id: 'minecraft:damage_taken', label: 'Damage taken', unit: 'damage' }
];

const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);

/**
 * A headline's value: a general stat, or a total. Distance travelled is every
 * way of moving except falling, which is not getting anywhere.
 */
export function headlineValue(stats: StatTable, id: string): number {
	if (id === 'total:distance') {
		return sum(Object.fromEntries(Object.entries(stats.custom).filter(([k]) => statUnit(k) === 'distance' && k !== 'minecraft:fall_one_cm')));
	}
	if (id === 'total:mined') return sum(stats.mined);
	if (id === 'total:crafted') return sum(stats.crafted);
	return stats.custom[id] ?? 0;
}
