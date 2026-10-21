import { db } from '#lib/server/db/index.js';
import { serverInstances } from '#lib/server/db/schema.js';

/**
 * A game port and its RCON port for a test server whose start() checks them
 * for real (portIsFree binds them). Each worker gets its own block, below
 * Linux's ephemeral range (32768+), where any socket of a test file running
 * alongside (listen(0), an RCON client) can land, and above ports.test.ts's
 * 20000-25020. Picking from 47100-55000 by pid and Math.random let the bisect
 * test's start be refused on CI: the files' ranges overlapped each other and
 * that range.
 *
 * The worker's database keeps every server earlier files made, and an
 * isolated file (vi.mock) starts this counter again: a pair a server there
 * already has is skipped, or a port check would meet that server (the port
 * overview's test did on CI, where fewer workers run more files each).
 */
const BLOCK = 200;
const base = 26000 + ((Number(process.env.VITEST_POOL_ID ?? 1) - 1) % 30) * BLOCK;
let next = 0;

export function testPorts(): { serverPort: number; rconPort: number } {
	const taken = new Set(
		db
			.select({ serverPort: serverInstances.serverPort, rconPort: serverInstances.rconPort })
			.from(serverInstances)
			.all()
			.flatMap((row) => [row.serverPort, row.rconPort])
	);
	for (let tries = 0; tries < BLOCK / 2; tries++) {
		const serverPort = base + ((next++ * 2) % BLOCK);
		if (!taken.has(serverPort) && !taken.has(serverPort + 1)) return { serverPort, rconPort: serverPort + 1 };
	}
	throw new Error(`Every port pair of this worker's block (${base}-${base + BLOCK - 1}) belongs to a server in its database.`);
}
