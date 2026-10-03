import type { ServerInstance } from './db/schema';
import { compareVersions } from './java';
import { rconPassword } from './instances';
import { rconExec } from './rcon';

/**
 * Ticks per second and milliseconds per tick, read over RCON with whatever
 * the server has: `forge tps` (Forge, Cleanroom), `neoforge tps`, or
 * vanilla's `tick query` (Minecraft 1.20.3+, so Fabric and Quilt there too).
 * Spark is not asked: it answers asynchronously, after RCON has returned.
 *
 * Formats, from the loaders' own language files:
 * - Forge 1.12:  "Overall : Mean tick time: 0.853 ms. Mean TPS: 20.000"
 * - Forge 1.13+: "Overall: Mean tick time: 0.853 ms. Mean TPS: 20.000"
 * - NeoForge:    "Overall: 20.000 TPS (0.853 ms/tick)"
 * - Vanilla:     "Target tick rate: 20.0 per second. Average time per tick: 0.3ms (Target: 50.0ms)"
 */

export type TickStats = { tps: number; mspt: number };

/** Forge formats with the JVM's locale, so "20,000" is possible. */
const num = (s: string) => Number(s.replace(',', '.'));

export function parseTickOutput(raw: string): TickStats | null {
	const text = raw.replace(/§./g, '');
	let m = text.match(/Overall\s*:\s*Mean tick time:\s*([\d.,]+)\s*ms\.\s*Mean TPS:\s*([\d.,]+)/);
	if (m) return { mspt: num(m[1]), tps: num(m[2]) };
	m = text.match(/Overall:\s*([\d.,]+)\s*TPS\s*\(([\d.,]+)\s*ms\/tick\)/);
	if (m) return { tps: num(m[1]), mspt: num(m[2]) };
	const rate = text.match(/Target tick rate:\s*([\d.,]+)/);
	const avg = text.match(/Average time per tick:\s*([\d.,]+)\s*ms/);
	if (rate && avg) {
		const mspt = num(avg[1]);
		// A tick faster than its slot waits for the next one; a slower one stretches it.
		return { mspt, tps: Math.min(num(rate[1]), mspt > 0 ? 1000 / mspt : num(rate[1])) };
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
