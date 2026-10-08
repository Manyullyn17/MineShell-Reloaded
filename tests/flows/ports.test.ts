import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { movePortAside } = await import('#lib/server/instances.js');
const { portUser, rconPortFor, RCON_OFFSET } = await import('#lib/server/ports.js');
const { createInstance, reload } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

/** Ports clear of anything on the machine (25565 is taken here) and of other test files. */
const base = 20000 + (process.pid % 200) * 20;

async function server(name: string, serverPort: number, rconPort: number) {
	return createInstance({ name, modloader: 'vanilla', minecraftVersion: '1.21.1', serverPort, rconPort }, { 'server.properties': `server-port=${serverPort}\nrcon.port=${rconPort}\n` });
}
const props = async (dir: string) => fs.readFile(path.join(dir, 'server.properties'), 'utf8');

describe('ports', () => {
	it('puts RCON 1000 above the game port, clear of the ports Linux lends to outgoing connections', async () => {
		expect(RCON_OFFSET).toBe(1000);
		expect(await rconPortFor(base)).toBe(base + 1000);
		expect(base + 1000).toBeLessThan(32768);
	});

	it('swaps game ports between two servers', async () => {
		fakeProcesses(() => ({ stdout: 'ActiveState=inactive\n' }));
		const a = await server('A', base + 1, base + 1001);
		const b = await server('B', base + 2, base + 1002);
		// A wants B's game port; B takes A's.
		expect(await movePortAside(a.id, base + 2, 'game', 'swap')).toMatchObject({ name: 'B', kind: 'game', to: base + 1, running: false });
		expect(reload(b.id).serverPort).toBe(base + 1);
		expect(await props(b.path)).toContain(`server-port=${base + 1}`);
		expect(portUser(base + 2, a.id)).toBeNull();
	});

	it('moves an RCON port that is in the way to a free one near its game port', async () => {
		fakeProcesses(() => ({ stdout: 'ActiveState=active\n' }));
		const a = await server('C', base + 5, base + 1005);
		// D's RCON port sits where C wants its game port (the old 25575-style clash).
		const d = await server('D', base + 6, base + 7);
		const moved = await movePortAside(a.id, base + 7, 'game', 'free');
		expect(moved).toMatchObject({ name: 'D', kind: 'rcon', to: base + 1006, running: true });
		expect(reload(d.id).rconPort).toBe(base + 1006);
		expect(await props(d.path)).toContain(`rcon.port=${base + 1006}`);
	});
});
