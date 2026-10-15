/** Advice on a server's maximum memory (lib/server/memoryadvice.ts), as pages get it. */
export type MemoryAdvice =
	| { kind: 'unknown'; currentMb: number; hours: number; playedHours: number; playedDays: number }
	| { kind: 'ok'; currentMb: number; neededMb: number; hours: number }
	| { kind: 'more'; reason: 'out-of-memory' | 'full'; currentMb: number; suggestedMb: number | null; neededMb: number | null; oomAt: number | null; hours: number }
	| { kind: 'less'; currentMb: number; suggestedMb: number; neededMb: number; hours: number };

/** Hours of samples before anything is said from them. */
export const MIN_HOURS = 6;
/**
 * Time with players online before it suggests less, counted from the minutes
 * they were on: an empty server says little about a busy one, and a few short
 * sessions say little about a usual evening.
 */
export const MIN_PLAYED_HOURS = 5;
/** Days with at least MIN_MINUTES_PER_DAY of play before it suggests less. */
export const MIN_PLAYED_DAYS = 3;
export const MIN_MINUTES_PER_DAY = 20;
