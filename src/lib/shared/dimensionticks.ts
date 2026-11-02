/**
 * The overview's per-dimension tick table. A big pack lists every dimension it registers
 * (1.16+ keeps them all loaded), so the table starts with the busy ones: slowest first,
 * at most SHOWN, at least FLOOR, stopping at the first idle one. The rest are a click away;
 * nothing is ever left out for good, so a dimension wrongly counted idle costs nothing.
 */

/** Under this a dimension takes no time worth looking at: an empty one ticks in ~0.01 ms. */
export const IDLE_MSPT = 0.1;
const SHOWN = 8;
const FLOOR = 3;
/** Hiding this few saves nothing: they are shown instead of a button. */
const WORTH_HIDING = 3;

type Tick = { mspt: number };

export function dimensionRows<T extends Tick>(dimensions: T[], all: boolean): { rows: T[]; hidden: number; idle: number } {
	const sorted = [...dimensions].sort((a, b) => b.mspt - a.mspt);
	const busy = sorted.filter((d) => d.mspt >= IDLE_MSPT).length;
	const count = Math.min(SHOWN, Math.max(busy, FLOOR));
	if (all || sorted.length - count < WORTH_HIDING) return { rows: sorted, hidden: 0, idle: 0 };
	const rest = sorted.slice(count);
	return { rows: sorted.slice(0, count), hidden: rest.length, idle: rest.filter((d) => d.mspt < IDLE_MSPT).length };
}
