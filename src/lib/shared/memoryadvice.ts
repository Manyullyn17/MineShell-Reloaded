/** Advice on a server's maximum memory (lib/server/memoryadvice.ts), as pages get it. */
export type MemoryAdvice =
	| { kind: 'unknown'; currentMb: number; hours: number }
	| { kind: 'ok'; currentMb: number; neededMb: number; hours: number }
	| { kind: 'more'; reason: 'out-of-memory' | 'full'; currentMb: number; suggestedMb: number | null; neededMb: number | null; oomAt: number | null; hours: number }
	| { kind: 'less'; currentMb: number; suggestedMb: number; neededMb: number; hours: number };
