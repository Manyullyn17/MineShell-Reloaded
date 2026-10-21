import { describe, expect, it } from 'vitest';
import { createInstance } from './instances';
import { testPorts } from './ports';

/**
 * The worker's database keeps every server earlier test files made, so a
 * port pair handed out again clashes with one of them: the port overview's
 * test found another server on its RCON port on CI (fewer workers, more
 * files each).
 */
describe('testPorts', () => {
	it('never hands out a pair a server in the database has, however many it hands out', async () => {
		const pairs = [];
		for (let i = 0; i < 26; i++) {
			const ports = testPorts();
			pairs.push(ports.serverPort, ports.rconPort);
			await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', ...ports });
		}
		expect(new Set(pairs).size).toBe(pairs.length);
	});
});
