import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ answers: {} as Record<string, string>, down: false }));
vi.mock('$lib/server/rcon', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/rcon')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		if (rcon.down) throw new Error('connection refused');
		return commands.map((c) => rcon.answers[c] ?? '');
	})
}));

const { listPlayerData, listBackups, readPlayerData, restorePlayerBackup, savePlayerData, playerView } = await import('$lib/server/playerdata');
const { writeNbt } = await import('$lib/server/nbt');
const { encryptSecret } = await import('$lib/server/crypto');
const { invalidateUnitState } = await import('$lib/server/systemd');
const { createInstance, systemdStopped } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

const ALEX = '0c5b0b6e-7f6a-4f53-9d36-5a9d1d1f0a11';
const STEVE = '8667ba71-b85a-4004-af54-457a9734eed7';

const playerFile = (xp: number) =>
	writeNbt({
		name: '',
		gzipped: true,
		root: { type: 'compound', value: [['DataVersion', { type: 'int', value: 3955 }], ['XpLevel', { type: 'int', value: xp }]] }
	});

async function server() {
	return createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1', rconPort: 25599, rconPasswordEnc: encryptSecret('pw') },
		{
			'server.properties': 'level-name=survival\n',
			[`survival/playerdata/${ALEX}.dat`]: playerFile(3),
			[`survival/playerdata/${STEVE}.dat`]: playerFile(7),
			'usercache.json': JSON.stringify([{ name: 'Alex', uuid: ALEX, expiresOn: '2027-01-01' }])
		}
	);
}

function running() {
	invalidateUnitState();
	fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\n' } : {}));
}

const xpOf = async (instance: Awaited<ReturnType<typeof server>>, uuid: string) =>
	playerView((await readPlayerData(instance, uuid)).file).stats.xpLevel;

describe('player data', () => {
	beforeEach(() => {
		systemdStopped();
		rcon.answers = {};
		rcon.down = false;
	});

	it('lists the player files in the world level-name points at, named from usercache.json', async () => {
		const instance = await server();
		const files = await listPlayerData(instance);
		expect(files.map((f) => [f.uuid, f.name]).sort()).toEqual([
			[ALEX, 'Alex'],
			[STEVE, null]
		]);
	});

	it('saves edits, backing up the previous file once per editing session', async () => {
		const instance = await server();
		const { version } = await readPlayerData(instance, ALEX);
		const next = await savePlayerData(instance, ALEX, version, [{ op: 'set', path: ['XpLevel'], value: '30' }]);
		await savePlayerData(instance, ALEX, next, [{ op: 'set', path: ['XpLevel'], value: '31' }]);
		expect(await xpOf(instance, ALEX)).toBe(31);

		const backups = await listBackups(instance, ALEX);
		expect(backups).toHaveLength(1);
		const backup = await fs.readFile(path.join(instance.path, '.mineshell/playerdata-backups', ALEX, backups[0].name));
		expect(backup.equals(playerFile(3))).toBe(true);
	});

	it('refuses to write over a file that changed since it was opened', async () => {
		const instance = await server();
		const { version } = await readPlayerData(instance, ALEX);
		// The player joined and left in the meantime.
		await fs.writeFile(path.join(instance.path, 'survival/playerdata', `${ALEX}.dat`), playerFile(9));
		await expect(savePlayerData(instance, ALEX, version, [{ op: 'set', path: ['XpLevel'], value: '1' }])).rejects.toThrow(/changed since you opened it/);
		expect(await xpOf(instance, ALEX)).toBe(9);
	});

	it('refuses an online player while the server runs, but edits one who is offline', async () => {
		const instance = await server();
		running();
		rcon.answers['list uuids'] = `There are 1 of a max of 20 players online: Alex (${ALEX})`;
		const alex = await readPlayerData(instance, ALEX);
		await expect(savePlayerData(instance, ALEX, alex.version, [{ op: 'set', path: ['XpLevel'], value: '1' }])).rejects.toThrow(/Alex is online/);

		const steve = await readPlayerData(instance, STEVE);
		await savePlayerData(instance, STEVE, steve.version, [{ op: 'set', path: ['XpLevel'], value: '1' }]);
		expect(await xpOf(instance, STEVE)).toBe(1);
	});

	it('maps names to UUIDs when the server cannot list UUIDs (1.12), and refuses when it cannot tell', async () => {
		const instance = await server();
		running();
		rcon.answers['list uuids'] = 'There are 1/20 players online:';
		rcon.answers['list'] = 'There are 1/20 players online:\nAlex';
		const alex = await readPlayerData(instance, ALEX);
		await expect(savePlayerData(instance, ALEX, alex.version, [])).rejects.toThrow(/is online/);

		// Someone usercache.json does not know: could be anyone.
		rcon.answers['list'] = 'There are 1/20 players online:\nStranger';
		const steve = await readPlayerData(instance, STEVE);
		await expect(savePlayerData(instance, STEVE, steve.version, [])).rejects.toThrow(/cannot tell who is online/);

		// A server that answers neither command with a player list.
		rcon.answers['list uuids'] = 'Unknown command';
		rcon.answers['list'] = 'Unknown command';
		await expect(savePlayerData(instance, STEVE, steve.version, [])).rejects.toThrow(/cannot tell who is online/);

		rcon.down = true;
		await expect(savePlayerData(instance, STEVE, steve.version, [])).rejects.toThrow(/cannot tell who is online/);
	});

	it('restores a backup, backing up the current file first', async () => {
		const instance = await server();
		const first = await readPlayerData(instance, ALEX);
		const saved = await savePlayerData(instance, ALEX, first.version, [{ op: 'set', path: ['XpLevel'], value: '50' }]);
		const [backup] = await listBackups(instance, ALEX);
		await restorePlayerBackup(instance, ALEX, saved, backup.name);
		expect(await xpOf(instance, ALEX)).toBe(3);
		expect(await listBackups(instance, ALEX)).toHaveLength(2);
	});

	it('only takes player ids as file names', async () => {
		const instance = await server();
		await expect(readPlayerData(instance, '../../server.properties')).rejects.toThrow(/not a player id/);
		await expect(restorePlayerBackup(instance, ALEX, 'x', '../x.dat')).rejects.toThrow(/No such backup/);
	});
});
