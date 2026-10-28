import type { ServerInstance } from './db/schema';
import { compareVersions } from './java';
import { rconPassword } from './instances';
import { rconExec } from './rcon';
import { words } from './dimensionnames';

/**
 * Ticks per second and milliseconds per tick, read over RCON with whatever
 * the server has: `forge tps` (Forge, Cleanroom), `neoforge tps`, or
 * vanilla's `tick query` (Minecraft 1.20.3+, so Fabric and Quilt there too).
 * Spark is not asked: it answers asynchronously, after RCON has returned.
 *
 * Formats, from the loaders' own language files and commands:
 * - Forge 1.12:  "Overall : Mean tick time: 0.853 ms. Mean TPS: 20.000", each
 *   dimension "Dim  7 (TwilightForest) : Mean tick time: ..." (the name only
 *   when the dimension type is registered)
 * - Forge 1.13+: "Overall: Mean tick time: 0.853 ms. Mean TPS: 20.000", each
 *   dimension "Dim minecraft:the_nether (minecraft:the_nether): Mean tick time: ..."
 *   (the level, then its dimension type)
 * - NeoForge:    "Overall: 20.000 TPS (0.853 ms/tick)", each dimension by its
 *   description: "The Nether: 20.000 TPS (0.853 ms/tick)" (21.1; a mod's dimension
 *   without a name in a language file by its id)
 * - Vanilla:     "Target tick rate: 20.0 per second. Average time per tick: 0.3ms (Target: 50.0ms)",
 *   no dimensions
 * Over RCON the lines often run together ("...Mean TPS: 20.000Dim -1 : ..."), so
 * entries are found by their shape, not by line.
 */

export type DimensionTick = {
	/** minecraft:the_nether on Forge 1.13+, the number on 1.12 ("-1"), NeoForge's name ("The Nether"). */
	id: string;
	label: string;
	tps: number;
	mspt: number;
};

export type TickStats = { tps: number; mspt: number; dimensions: DimensionTick[] };

/** Forge formats with the JVM's locale, so "20,000" is possible. */
const num = (s: string) => Number(s.replace(',', '.'));

const VANILLA_DIMENSIONS: Record<string, string> = {
	'minecraft:overworld': 'Overworld',
	'minecraft:the_nether': 'The Nether',
	'minecraft:the_end': 'The End',
	'0': 'Overworld',
	'-1': 'The Nether',
	'1': 'The End'
};

/**
 * Vanilla's by name; 1.12's numbered ones by the type name Forge gave ("Twilight Forest
 * (DIM7)", the same names as `forge dimensions`), 1.13+ ones keep their id, as the
 * World tab shows them.
 */
export function dimensionTickLabel(id: string, typeName: string | null): string {
	if (VANILLA_DIMENSIONS[id]) return VANILLA_DIMENSIONS[id];
	if (!/^-?\d+$/.test(id)) return id;
	return typeName ? `${words(typeName.replace(/^\w+:/, ''))} (DIM${id})` : `DIM${id}`;
}

function dimensionLines(text: string): DimensionTick[] {
	const out: DimensionTick[] = [];
	for (const m of text.matchAll(/Dim\s+(.+?)(?:\s+\(([^()]*)\))?\s*:\s*Mean tick time:\s*([\d.,]+)\s*ms\.\s*Mean TPS:\s*([\d.,]+)/g)) {
		const id = m[1].trim();
		out.push({ id, label: dimensionTickLabel(id, m[2] ?? null), mspt: num(m[3]), tps: num(m[4]) });
	}
	if (out.length) return out;
	for (const m of text.matchAll(/([^()\n]+?):\s*([\d.,]+)\s*TPS\s*\(([\d.,]+)\s*ms\/tick\)/g)) {
		const id = m[1].trim();
		if (id === 'Overall') continue;
		out.push({ id, label: dimensionTickLabel(id, null), tps: num(m[2]), mspt: num(m[3]) });
	}
	return out;
}

export function parseTickOutput(raw: string): TickStats | null {
	const text = raw.replace(/§./g, '');
	let m = text.match(/Overall\s*:\s*Mean tick time:\s*([\d.,]+)\s*ms\.\s*Mean TPS:\s*([\d.,]+)/);
	if (m) return { mspt: num(m[1]), tps: num(m[2]), dimensions: dimensionLines(text) };
	m = text.match(/Overall:\s*([\d.,]+)\s*TPS\s*\(([\d.,]+)\s*ms\/tick\)/);
	if (m) return { tps: num(m[1]), mspt: num(m[2]), dimensions: dimensionLines(text) };
	const rate = text.match(/Target tick rate:\s*([\d.,]+)/);
	const avg = text.match(/Average time per tick:\s*([\d.,]+)\s*ms/);
	if (rate && avg) {
		const mspt = num(avg[1]);
		// A tick faster than its slot waits for the next one; a slower one stretches it.
		return { mspt, tps: Math.min(num(rate[1]), mspt > 0 ? 1000 / mspt : num(rate[1])), dimensions: [] };
	}
	return null;
}

/** The commands worth trying on this server, best first. */
export function tickCommands(instance: Pick<ServerInstance, 'modloader' | 'minecraftVersion'>): string[] {
	const commands: string[] = [];
	if (instance.modloader === 'forge' || instance.modloader === 'cleanroom') commands.push('forge tps');
	if (instance.modloader === 'neoforge') commands.push('neoforge tps');
	if (/^\d/.test(instance.minecraftVersion) && compareVersions(instance.minecraftVersion, '1.20.3') >= 0) {
		commands.push('tick query');
	}
	return commands;
}

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; stats: TickStats | null }>();

/** Null when the server has no way to say, or did not answer. Cached briefly: the overview polls. */
export async function tickStats(instance: ServerInstance): Promise<TickStats | null> {
	const hit = cache.get(instance.id);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.stats;
	const password = rconPassword(instance);
	let stats: TickStats | null = null;
	if (password) {
		for (const command of tickCommands(instance)) {
			try {
				const [answer] = await rconExec({ port: instance.rconPort, password }, [command]);
				stats = parseTickOutput(answer ?? '');
				if (stats) break;
			} catch {
				break;
			}
		}
	}
	cache.set(instance.id, { at: Date.now(), stats });
	return stats;
}
