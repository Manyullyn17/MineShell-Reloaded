import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDefaultPlayers, namesFromText, offlineUuid, writeDefaultPlayers } from './defaultplayers';

const NOTCH = { name: 'Notch', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5' };
const JEB = { name: 'jeb_', uuid: '853c80ef-3c37-49fd-aa49-938b674adae6' };

describe("New server defaults' players", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'defaultplayers-'));
	});
	afterEach(() => fs.rm(dir, { recursive: true, force: true }));
	const read = async (file: string) => JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));

	// The value Java's UUID.nameUUIDFromBytes("OfflinePlayer:Notch") gives, as offline servers list him.
	it('gives a name the UUID an offline-mode server gives it', () => {
		expect(offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
	});

	it('writes the whitelist and the operators at the server’s operator level, keeping what is there', async () => {
		await fs.writeFile(path.join(dir, 'whitelist.json'), JSON.stringify([{ uuid: JEB.uuid, name: 'jeb_' }]));
		await writeDefaultPlayers(dir, { whitelist: [NOTCH, JEB], ops: [NOTCH] }, { 'online-mode': 'true', 'op-permission-level': '3' });
		expect(await read('whitelist.json')).toEqual([{ uuid: JEB.uuid, name: 'jeb_' }, NOTCH]);
		expect(await read('ops.json')).toEqual([{ ...NOTCH, level: 3, bypassesPlayerLimit: false }]);
	});

	it('lists them under offline UUIDs on a server that does not verify accounts', async () => {
		await writeDefaultPlayers(dir, { whitelist: [NOTCH], ops: [] }, { 'online-mode': 'false' });
		expect(await read('whitelist.json')).toEqual([{ uuid: offlineUuid('Notch'), name: 'Notch' }]);
		await expect(fs.access(path.join(dir, 'ops.json'))).rejects.toThrow();
	});

	it('reads a hand-edited row as only its valid players', () => {
		const stored = { whitelist: [NOTCH, NOTCH, { name: 'has space', uuid: JEB.uuid }, { name: 'x' }, 'Steve'], ops: 'jeb_' };
		expect(cleanDefaultPlayers(stored)).toEqual({ whitelist: [NOTCH], ops: [] });
		expect(cleanDefaultPlayers(null)).toEqual({ whitelist: [], ops: [] });
	});

	it('takes names one a line, or with commas or spaces, each once', () => {
		expect(namesFromText(' Notch\n\njeb_, Dinnerbone notch\r\n')).toEqual(['Notch', 'jeb_', 'Dinnerbone']);
	});
});
