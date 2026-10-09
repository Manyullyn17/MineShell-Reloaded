import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fetchCalls, useRecordedHttp } from '../../../tests/helpers/http';

const { cachedProfileNames, isOfflineUuid, lookUpProfileNames, resetProfileCache } = await import('./profiles');
const { listPlayerData } = await import('./playerdata');
const { createInstance } = await import('../../../tests/helpers/instances');
const { CACHE_DIR } = await import('./config');

const NOTCH = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const NOBODY = '00000000-0000-4000-8000-000000000000';
// What an offline-mode server makes of "Steve" (version 3).
const OFFLINE = '5627dd98-e6be-3c21-b8a8-e92344183641';
const LIMITED = '11111111-1111-4111-8111-111111111111';
const profileUrl = (uuid: string) => `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`;

useRecordedHttp('mojang-profiles', {
	extra: { [profileUrl(LIMITED)]: () => new Response('{"error":"TooManyRequestsException"}', { status: 429 }) }
});

beforeEach(async () => {
	resetProfileCache();
	await fs.rm(path.join(CACHE_DIR, 'profiles.json'), { force: true });
	fetchCalls.length = 0;
});

describe('player names from Mojang', () => {
	it("names an online-mode UUID with the account's name", async () => {
		const names = await lookUpProfileNames([NOTCH]);
		expect(names.get(NOTCH)).toBe('Notch');
	});

	it('keeps what it learned, a missing account too, across restarts', async () => {
		await lookUpProfileNames([NOTCH, NOBODY]);
		resetProfileCache();
		fetchCalls.length = 0;
		const names = await lookUpProfileNames([NOTCH, NOBODY]);
		expect(fetchCalls).toEqual([]);
		expect(names.get(NOTCH)).toBe('Notch');
		expect(names.has(NOBODY)).toBe(false);
		expect((await cachedProfileNames([NOTCH])).get(NOTCH)).toBe('Notch');
	});

	it('never asks about an offline-mode UUID', async () => {
		expect(isOfflineUuid(OFFLINE)).toBe(true);
		expect(isOfflineUuid(NOTCH)).toBe(false);
		await lookUpProfileNames([OFFLINE]);
		expect(fetchCalls).toEqual([]);
	});

	it('asks again after a refused request instead of remembering it as no account', async () => {
		await lookUpProfileNames([LIMITED]);
		await lookUpProfileNames([LIMITED]);
		expect(fetchCalls.filter((c) => c.url === profileUrl(LIMITED))).toHaveLength(2);
	});
});

describe('naming player files', () => {
	const files = (uuids: string[], extra: Record<string, string> = {}) =>
		Object.fromEntries([...uuids.map((u) => [`world/playerdata/${u}.dat`, 'nbt']), ['server.properties', 'level-name=world'], ...Object.entries(extra)]);

	it("takes names from the server's lists when the usercache is missing", async () => {
		const instance = await createInstance(
			{ modloader: 'vanilla', minecraftVersion: '1.21.1' },
			files([NOTCH], { 'whitelist.json': JSON.stringify([{ uuid: NOTCH, name: 'Notch' }]) })
		);
		expect((await listPlayerData(instance))[0]).toMatchObject({ uuid: NOTCH, name: 'Notch', nameFrom: 'server' });
	});

	it("uses Mojang's name once looked up, and marks offline-mode players", async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, files([NOTCH, OFFLINE]));
		let list = await listPlayerData(instance);
		expect(list.find((f) => f.uuid === NOTCH)).toMatchObject({ name: null, offline: false });
		expect(list.find((f) => f.uuid === OFFLINE)).toMatchObject({ name: null, offline: true });

		await lookUpProfileNames(list.map((f) => f.uuid));
		list = await listPlayerData(instance);
		expect(list.find((f) => f.uuid === NOTCH)).toMatchObject({ name: 'Notch', nameFrom: 'mojang' });
	});
});
