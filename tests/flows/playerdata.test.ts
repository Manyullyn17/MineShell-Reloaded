import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ answers: {} as Record<string, string | (() => string)>, down: false }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		if (rcon.down) throw new Error('connection refused');
		return commands.map((c) => {
			const answer = rcon.answers[c];
			return typeof answer === 'function' ? answer() : (answer ?? '');
		});
	})
}));

const { listPlayerData, listBackups, readPlayerData, restorePlayerBackup, savePlayerData, playerView } = await import('#lib/server/playerdata.js');
const { writeNbt } = await import('#lib/server/nbt.js');
const { addCustomField, copyCustomFields, listCustomFields, remapCustomField, removeCustomField } = await import('#lib/server/playerfields.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
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
	Number(playerView((await readPlayerData(instance, uuid)).file).fields.find((f) => f.key === 'xpLevel')?.value);

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

	it('saves a 1.7 player\'s items by the numbers in the world\'s Forge registry, or vanilla 1.7.10\'s', async () => {
		const short = (value: number) => ({ type: 'short' as const, value });
		const legacyPlayer = () =>
			writeNbt({ name: '', gzipped: true, root: { type: 'compound', value: [['Inventory', { type: 'list', itemType: 'compound', value: [{ type: 'compound', value: [['id', short(264)], ['Count', { type: 'byte', value: 2 }], ['Damage', short(0)], ['Slot', { type: 'byte', value: 0 }]] }] }]] } });
		const entry = (k: string, v: number) => ({ type: 'compound' as const, value: [['K', { type: 'string' as const, value: k }], ['V', { type: 'int' as const, value: v }]] as [string, never][] });
		const level = writeNbt({
			name: '',
			gzipped: true,
			root: { type: 'compound', value: [['FML', { type: 'compound', value: [['ItemData', { type: 'list', itemType: 'compound', value: [entry('\u0002minecraft:diamond', 264), entry('\u0001Botania:flower', 4000), entry('\u0002Botania:manaResource', 4100)] }]] }]] }
		});
		const forge = await createInstance(
			{ modloader: 'forge', minecraftVersion: '1.7.10' },
			{ 'server.properties': 'level-name=world\n', 'world/level.dat': level, [`world/playerdata/${ALEX}.dat`]: legacyPlayer() }
		);
		const ids = async (instance: typeof forge) => {
			const { file } = await readPlayerData(instance, ALEX);
			const { legacyItemIds } = await import('#lib/server/itemids.js');
			return playerView(file, await legacyItemIds(instance)).items.map((x) => x.id);
		};
		expect(await ids(forge)).toEqual(['minecraft:diamond']);
		await savePlayerData(forge, ALEX, (await readPlayerData(forge, ALEX)).version, [{ op: 'item', section: 'main', slot: 1, id: 'Botania:manaResource', count: 1 }]);
		expect(await ids(forge)).toEqual(['minecraft:diamond', 'Botania:manaResource']);
		// A block's number is not an item's.
		await expect(savePlayerData(forge, ALEX, (await readPlayerData(forge, ALEX)).version, [{ op: 'item', section: 'main', slot: 2, id: 'Botania:flower', count: 1 }])).rejects.toThrow(/no item/);

		// Vanilla 1.7.10 has no registry in level.dat: its own fixed numbers.
		const vanilla = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.7.10' }, { 'server.properties': 'level-name=world\n', [`world/playerdata/${ALEX}.dat`]: legacyPlayer() });
		await savePlayerData(vanilla, ALEX, (await readPlayerData(vanilla, ALEX)).version, [{ op: 'item', section: 'main', slot: 1, id: 'minecraft:cooked_fished', count: 3 }]);
		expect(await ids(vanilla)).toEqual(['minecraft:diamond', 'minecraft:cooked_fished']);
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

	it('keeps both backups when a save and a restore fall in the same millisecond', async () => {
		const instance = await server();
		const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
		try {
			const saved = await savePlayerData(instance, ALEX, (await readPlayerData(instance, ALEX)).version, [{ op: 'set', path: ['XpLevel'], value: '50' }]);
			const [backup] = await listBackups(instance, ALEX);
			await restorePlayerBackup(instance, ALEX, saved, backup.name);
			const backups = await listBackups(instance, ALEX);
			expect(backups).toHaveLength(2);
			// The first (XP 3) is still there, not overwritten by the second (XP 50).
			const levels = [];
			for (const b of backups) {
				const { parseNbt } = await import('#lib/server/nbt.js');
				const file = parseNbt(await fs.readFile(path.join(instance.path, '.mineshell/playerdata-backups', ALEX, b.name)));
				levels.push(playerView(file).fields.find((f) => f.key === 'xpLevel')?.value);
			}
			expect(levels.map(Number).sort()).toEqual([3, 50]);
		} finally {
			now.mockRestore();
		}
	});

	it('only takes player ids as file names', async () => {
		const instance = await server();
		await expect(readPlayerData(instance, '../../server.properties')).rejects.toThrow(/not a player id/);
		await expect(restorePlayerBackup(instance, ALEX, 'x', '../x.dat')).rejects.toThrow(/No such backup/);
	});

	it('keeps mapped fields per server: add, remap in place, remove, copy to a clone', async () => {
		const instance = await server();
		const other = await server();
		addCustomField(instance.id, { label: 'Mana', path: ['ManaData', 'mana'], kind: 'number' });
		addCustomField(instance.id, { label: 'Level', path: ['XpLevel'], kind: 'number' });
		expect(listCustomFields(other.id)).toEqual([]);
		const [mana, level] = listCustomFields(instance.id);
		expect(mana).toMatchObject({ label: 'Mana', path: ['ManaData', 'mana'], kind: 'number' });

		remapCustomField(instance.id, mana.id, ['Mana', 'current']);
		expect(listCustomFields(instance.id)[0]).toMatchObject({ id: mana.id, label: 'Mana', path: ['Mana', 'current'] });
		removeCustomField(instance.id, level.id);
		expect(listCustomFields(instance.id).map((f) => f.label)).toEqual(['Mana']);

		copyCustomFields(instance.id, other.id);
		expect(listCustomFields(other.id)).toMatchObject([{ label: 'Mana', path: ['Mana', 'current'] }]);

		expect(() => addCustomField(instance.id, { label: ' ', path: ['x'], kind: 'number' })).toThrow(/name/);
		expect(() => addCustomField(instance.id, { label: 'x', path: [], kind: 'number' })).toThrow(/not a place/);
		expect(() => addCustomField(instance.id, { label: 'x', path: ['x'], kind: 'slider' })).toThrow(/how the field/);
	});

	it('asks again right before writing, and leaves the file alone if the player joined meanwhile', async () => {
		const instance = await server();
		running();
		let asked = 0;
		// Offline when the save starts, online by the time the file would be swapped.
		rcon.answers['list uuids'] = () =>
			++asked === 1 ? 'There are 0 of a max of 20 players online: ' : `There are 1 of a max of 20 players online: Alex (${ALEX})`;
		const { version } = await readPlayerData(instance, ALEX);
		await expect(savePlayerData(instance, ALEX, version, [{ op: 'set', path: ['XpLevel'], value: '40' }])).rejects.toThrow(/Alex is online/);
		expect(asked).toBe(2);
		expect(await xpOf(instance, ALEX)).toBe(3);
		expect(await fs.readdir(path.join(instance.path, 'survival/playerdata'))).not.toContain(`${ALEX}.dat.mineshell-tmp`);
	});
});
