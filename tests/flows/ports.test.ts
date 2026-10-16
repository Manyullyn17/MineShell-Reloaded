import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

const { freePortFor, setServerPort, portChangeProblem, serverPorts, buildOverview, parseNetTable, unitOf } = await import('#lib/server/portmap.js');
const { saveMapSettings } = await import('#lib/server/worldmap.js');
const { UNIT_PREFIX } = await import('#lib/server/config.js');

describe('ports of every kind', () => {
	const voiceConfig = (port: number) => ({ 'config/voicechat/voicechat-server.properties': `port=${port}\n` });

	it('gives a new port none that another server’s voice chat or map mod has', async () => {
		// Only game and RCON ports counted: a stopped server's voice chat port could be handed out again.
		fakeProcesses(() => ({ stdout: 'ActiveState=inactive\n' }));
		const e = await createInstance({ name: 'E', modloader: 'fabric', minecraftVersion: '1.21.1', serverPort: base + 10, rconPort: base + 11 }, voiceConfig(base + 1012));
		saveMapSettings(e.id, { modPort: base + 1013 });
		const f = await server('F', base + 12, base + 13);
		expect(await rconPortFor(base + 12, f.id)).toBe(base + 1014);
		expect(await freePortFor(f, 'rcon')).toBe(base + 1014);
	});

	it('lists each server’s ports, and refuses one another server has', async () => {
		fakeProcesses(() => ({ stdout: 'ActiveState=inactive\n' }));
		const g = await createInstance({ name: 'G', modloader: 'fabric', minecraftVersion: '1.21.1', serverPort: base + 15, rconPort: base + 16 }, voiceConfig(-1));
		const entries = (await serverPorts([g])).map((e) => [e.kind, e.port, e.protocol, e.followsGame]);
		expect(entries).toEqual([
			['game', base + 15, 'tcp', false],
			['rcon', base + 16, 'tcp', false],
			['voice', base + 15, 'udp', true]
		]);
		expect(await portChangeProblem(g, 'game', base + 16)).toMatch(/RCON port/);
		expect(await portChangeProblem(g, 'query', base + 17)).toMatch(/follows the game port/);
		const h = await server('H', base + 17, base + 18);
		expect(await portChangeProblem(h, 'rcon', base + 16)).toMatch(/G uses port/);
	});

	it('writes a changed port where that port is configured', async () => {
		fakeProcesses(() => ({ stdout: 'ActiveState=inactive\n' }));
		const k = await createInstance({ name: 'K', modloader: 'fabric', minecraftVersion: '1.21.1', serverPort: base + 19, rconPort: base + 1019 }, voiceConfig(base + 1100));
		await setServerPort(k, 'game', base + 3);
		expect(reload(k.id).serverPort).toBe(base + 3);
		expect(await props(k.path)).toContain(`server-port=${base + 3}`);
		await setServerPort(reload(k.id), 'voice', base + 1101);
		expect(await fs.readFile(path.join(k.path, 'config/voicechat/voicechat-server.properties'), 'utf8')).toContain(`port=${base + 1101}`);
		await setServerPort(reload(k.id), 'map', base + 1102);
		expect((await serverPorts([reload(k.id)])).find((e) => e.kind === 'map')?.port).toBe(base + 1102);
	});

	it('reads listening sockets from /proc/net and the server a process belongs to', () => {
		const tcp = [
			'  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
			'   0: 00000000:63DD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1',
			'   1: 0100007F:63DE 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 222 1'
		].join('\n');
		expect(parseNetTable(tcp, 'tcp')).toEqual([{ port: 25565, protocol: 'tcp', inode: 111 }]);
		expect(parseNetTable(tcp.replace(' 0A ', ' 07 '), 'udp')).toEqual([{ port: 25565, protocol: 'udp', inode: 111 }]);
		expect(unitOf(`0::/user.slice/user@1000.service/app.slice/app-x.slice/${UNIT_PREFIX}@irithyll.service\n`)).toEqual({ unit: `${UNIT_PREFIX}@irithyll.service`, instanceId: 'irithyll' });
		// Another MineShell's server (another prefix) is another program to this one.
		expect(unitOf('0::/user.slice/user@1000.service/app.slice/app-other.slice/otherprefix@irithyll.service')).toEqual({ unit: 'otherprefix@irithyll.service', instanceId: null });
	});

	it('marks clashes, ports another program holds, and a running server still on its old port', () => {
		const entry = (instanceId: string, kind: 'game' | 'rcon', port: number) => ({ instanceId, name: instanceId, kind, port, protocol: 'tcp' as const, followsGame: false });
		const holder = (instanceId: string | null, unit: string | null) => ({ pid: 7, process: 'java', unit, instanceId });
		const overview = buildOverview(
			[entry('a', 'game', 30001), entry('b', 'game', 30001), entry('c', 'game', 30002), entry('d', 'game', 30003)],
			[
				{ port: 30002, protocol: 'tcp', inode: 1, holder: holder('c', 'minecraft@c.service') },
				{ port: 30003, protocol: 'tcp', inode: 2, holder: holder(null, 'mineshell@x.service') },
				{ port: 30009, protocol: 'tcp', inode: 3, holder: holder('d', 'minecraft@d.service') },
				{ port: 41000, protocol: 'tcp', inode: 4, holder: holder(null, null) },
				{ port: 25700, protocol: 'tcp', inode: 5, holder: holder(null, 'other.service') }
			],
			new Set(['c', 'd']),
			new Map([['d', 'D']])
		);
		const row = (id: string) => overview.rows.find((r) => r.instanceId === id)!;
		expect(row('a').clashes.map((c) => c.name)).toEqual(['b']);
		expect(row('c')).toMatchObject({ status: 'listening', clashes: [] });
		expect(row('d')).toMatchObject({ status: 'taken', holder: { unit: 'mineshell@x.service' } });
		// Far from the servers' ranges and nobody's: left out.
		expect(overview.others.map((o) => [o.port, o.oldPortOf])).toEqual([
			[25700, null],
			[30009, 'D']
		]);
	});
});

const { allocatePortPair, DEFAULT_PORT_RANGES, portRanges, portRangesProblem, rconStart, savePortRanges } = await import('#lib/server/ports.js');

describe('where new ports start', () => {
	afterEach(() => savePortRanges(DEFAULT_PORT_RANGES));

	it('gives new servers ports from the saved starts', async () => {
		fakeProcesses(() => ({ stdout: 'ActiveState=inactive\n' }));
		savePortRanges({ game: base + 1500, rconOffset: 7, voice: base + 1600, map: base + 1700 });
		expect(await allocatePortPair()).toEqual({ serverPort: base + 1500, rconPort: base + 1507 });
		const v = await createInstance({ name: 'V', modloader: 'fabric', minecraftVersion: '1.21.1', serverPort: base + 1550, rconPort: base + 1551 });
		expect(await freePortFor(v, 'voice')).toBe(base + 1600);
		expect(await freePortFor(v, 'map')).toBe(base + 1700);
	});

	it('keeps RCON clear of the outgoing-connection ports, and refuses ranges that do not fit', () => {
		const r = { ...DEFAULT_PORT_RANGES };
		expect(rconStart(25565, r)).toBe(26565);
		// 31800 + 1000 would land in 32768+: back to the first RCON port.
		expect(rconStart(31800, r)).toBe(26565);
		// Starts already up there: no such limit.
		expect(rconStart(61500, { ...r, game: 61000 })).toBe(62500);
		expect(portRangesProblem({ ...r, game: 80 })).toMatch(/Game ports/);
		expect(portRangesProblem({ ...r, rconOffset: 0 })).toMatch(/RCON/);
		expect(portRangesProblem({ ...r, game: 65000, rconOffset: 1000 })).toMatch(/below 65536/);
		savePortRanges({ ...r, game: 5 });
		expect(portRanges()).toEqual(DEFAULT_PORT_RANGES);
	});
});
