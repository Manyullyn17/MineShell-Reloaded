/**
 * A game port and its RCON port for a test server whose start() checks them
 * for real (portIsFree binds them). Each worker gets its own block, below
 * Linux's ephemeral range (32768+), where any socket of a test file running
 * alongside (listen(0), an RCON client) can land, and above ports.test.ts's
 * 20000-25020. Picking from 47100-55000 by pid and Math.random let the bisect
 * test's start be refused on CI: the files' ranges overlapped each other and
 * that range.
 */
const BLOCK = 50;
const base = 26000 + ((Number(process.env.VITEST_POOL_ID ?? 1) - 1) % 120) * BLOCK;
let next = 0;

export function testPorts(): { serverPort: number; rconPort: number } {
	const serverPort = base + ((next++ * 2) % BLOCK);
	return { serverPort, rconPort: serverPort + 1 };
}
