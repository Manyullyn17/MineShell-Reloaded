import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ commands: [] as string[], answer: '' }));
vi.mock('$lib/server/rcon', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/rcon')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map(() => rcon.answer);
	})
}));

// Mojang's profile lookup, for names added while the server is stopped.
vi.mock('$lib/server/download', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/download')>()),
	fetchJson: vi.fn(async (url: string) => {
		if (url.endsWith('/Notch')) return { id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch' };
		throw new Error('404');
	})
}));

const { addPlayer, banDate, loadPlayerLists, removePlayer, setOpOptions } = await import('$lib/server/players');
const { encryptSecret } = await import('$lib/server/crypto');
const { invalidateUnitState } = await import('$lib/server/systemd');
const { createInstance, systemdStopped } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

async function server(props = 'op-permission-level=2\n') {
	return createInstance(
		{ modloader: 'vanilla', minecraftVersion: '1.21.1', rconPort: 25597, rconPasswordEnc: encryptSecret('pw') },
		{ 'server.properties': props }
	);
}

type Server = Awaited<ReturnType<typeof server>>;
const readList = async (instance: Server, file: string) =>
	JSON.parse(await fs.readFile(path.join(instance.path, file), 'utf8')) as Record<string, unknown>[];

function running() {
	invalidateUnitState();
	fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\n' } : {}));
}

describe('player lists', () => {
	beforeEach(() => {
		systemdStopped();
		rcon.commands = [];
		rcon.answer = '';
	});

	it('writes ban dates the way vanilla parses them', () => {
		expect(banDate(new Date())).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}$/);
	});

	describe('stopped: edits the files', () => {
		it('bans with a reason, or vanilla\'s default reason', async () => {
			const instance = await server();
			expect((await addPlayer(instance, 'bans', 'Notch', { reason: '  griefing\nspawn ' })).ok).toBe(true);
			const [ban] = await readList(instance, 'banned-players.json');
			expect(ban).toMatchObject({ name: 'Notch', reason: 'griefing spawn', expires: 'forever', source: 'MineShell' });
			expect(String(ban.created)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}$/);

			await removePlayer(instance, 'bans', 'Notch');
			await addPlayer(instance, 'bans', 'Notch');
			expect((await readList(instance, 'banned-players.json'))[0].reason).toBe('Banned by an operator.');
		});

		it('bans an IP address, but not a player name it cannot resolve to one', async () => {
			const instance = await server();
			expect((await addPlayer(instance, 'ipBans', '203.0.113.7', { reason: 'bots' })).ok).toBe(true);
			expect((await addPlayer(instance, 'ipBans', '2001:db8::1')).ok).toBe(true);
			const byName = await addPlayer(instance, 'ipBans', 'Notch');
			expect(byName.ok).toBe(false);
			expect(byName.message).toContain('does not know this player');
			expect((await addPlayer(instance, 'ipBans', '203.0.113.7')).message).toContain('already banned');

			const lists = await loadPlayerLists(instance);
			expect(lists.ipBans.map((e) => [e.key, e.reason])).toEqual([
				['203.0.113.7', 'bots'],
				['2001:db8::1', 'Banned by an operator.']
			]);
			await removePlayer(instance, 'ipBans', '203.0.113.7');
			expect((await loadPlayerLists(instance)).ipBans.map((e) => e.key)).toEqual(['2001:db8::1']);
		});

		it('refuses what is not a player name, so nothing odd reaches a command', async () => {
			const instance = await server();
			for (const bad of ['Not ch', 'a;b', 'x'.repeat(17), '203.0.113.7']) {
				expect((await addPlayer(instance, 'bans', bad)).ok).toBe(false);
			}
		});

		it('adds an operator at the picked level and changes it later', async () => {
			const instance = await server();
			await addPlayer(instance, 'ops', 'Notch', { level: 2 });
			expect((await readList(instance, 'ops.json'))[0]).toMatchObject({ name: 'Notch', level: 2, bypassesPlayerLimit: false });

			expect((await setOpOptions(instance, 'notch', { level: 3, bypassesPlayerLimit: true })).ok).toBe(true);
			expect((await readList(instance, 'ops.json'))[0]).toMatchObject({ level: 3, bypassesPlayerLimit: true });
			expect((await setOpOptions(instance, 'Notch', { level: 9, bypassesPlayerLimit: false })).ok).toBe(false);
			expect((await setOpOptions(instance, 'Herobrine', { level: 1, bypassesPlayerLimit: false })).ok).toBe(false);
		});
	});

	describe('running: asks the server over RCON', () => {
		it('passes the reason to ban and ban-ip, and pardons an address', async () => {
			const instance = await server();
			running();
			rcon.answer = '§eBanned Notch: griefing';
			expect(await addPlayer(instance, 'bans', 'Notch', { reason: 'griefing' })).toEqual({ ok: true, message: 'Banned Notch: griefing' });
			await addPlayer(instance, 'ipBans', 'Alex', { reason: 'alt accounts' });
			await addPlayer(instance, 'ipBans', '203.0.113.7');
			await removePlayer(instance, 'ipBans', '203.0.113.7');
			await addPlayer(instance, 'ops', 'Notch', { level: 2 });
			expect(rcon.commands).toEqual([
				'ban Notch griefing',
				'ban-ip Alex alt accounts',
				'ban-ip 203.0.113.7',
				'pardon-ip 203.0.113.7',
				'op Notch'
			]);
		});

		it("passes on the server's refusal as a failure", async () => {
			const instance = await server();
			running();
			rcon.answer = 'Invalid IP address or unknown player';
			expect(await addPlayer(instance, 'ipBans', 'Alex')).toEqual({ ok: false, message: 'Invalid IP address or unknown player' });
			rcon.answer = 'Nothing changed. The player is already whitelisted';
			expect((await addPlayer(instance, 'whitelist', 'Alex')).ok).toBe(false);
			rcon.answer = 'Unbanned IP 203.0.113.7';
			expect((await removePlayer(instance, 'ipBans', '203.0.113.7')).ok).toBe(true);
		});

		it('does not edit operator levels the server would overwrite', async () => {
			const instance = await server();
			running();
			const result = await setOpOptions(instance, 'Notch', { level: 2, bypassesPlayerLimit: false });
			expect(result.ok).toBe(false);
			expect(result.message).toContain('Stop the server first');
		});

		it("reports the level op gives from server.properties", async () => {
			running();
			expect((await loadPlayerLists(await server())).defaultOpLevel).toBe(2);
			expect((await loadPlayerLists(await server(''))).defaultOpLevel).toBe(4);
		});
	});
});
