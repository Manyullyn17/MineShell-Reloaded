/**
 * The smallest memory limit (systemd MemoryMax) a server with this heap may
 * get. Java needs memory beyond its heap: metaspace, code cache, threads, GC
 * structures and mods' native memory. Measured 2026-10-15: irithyll (Fabric,
 * 10 GB heap) 890 MB, MeatballCraft (Cleanroom, 16 GB heap, ZGC) 1.5 GB right
 * after starting and 3.3 GB a few minutes in. Past the limit the kernel kills
 * the server, so this is a floor, not a recommendation.
 */
export function minMemoryLimitMb(heapMb: number): number {
	return Math.ceil(heapMb * 1.1) + 1024;
}

/** A limit with room for a busy big pack, rounded to the field's 256 MB steps. */
export function suggestedMemoryLimitMb(heapMb: number): number {
	return Math.ceil((heapMb * 1.25 + 1024) / 256) * 256;
}
