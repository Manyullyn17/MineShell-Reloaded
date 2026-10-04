import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({
	commands: [] as string[],
	answers: {} as Record<string, string>,
	players: 0
}));
vi.mock('$lib/server/rcon', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/rcon')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map((c) =>
			c === 'list' ? `There are ${rcon.players} of a max of 20 players online: ${rcon.players ? 'Alex' : ''}` : (rcon.answers[c] ?? '')
		);
	})
}));

const chunky = await import('$lib/server/chunky');
const { encryptSecret } = await import('$lib/server/crypto');
const { invalidateUnitState } = await import('$lib/server/systemd');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

/** As Chunky sends it over RCON: its prefix in colour, then task_update. */
const RUNNING =
	'§2[Chunky]§r Task running for minecraft:overworld. Processed: 12,345 chunks (12.34%), ETA: 1:05:12, Rate: 45.6 cps, Current: 12, -34';

async function server(files: Record<string, string> = {}) {
	return createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1', rconPort: 25596, rconPasswordEnc: encryptSecret('pw') },
		files
	);
}

describe('Chunky', () => {
	beforeEach(() => {
		rcon.commands = [];
		rcon.answers = {};
		rcon.players = 0;
		invalidateUnitState();
		fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\n' } : {}));
	});

	it('reads progress, in either number locale', () => {
		expect(chunky.parseProgress(chunky.plainChunky(RUNNING))).toEqual([
			{ world: 'minecraft:overworld', chunks: 12345, percent: 12.34, etaSeconds: 3912, rate: 45.6 }
		]);
		const comma = 'Task running for minecraft:the_nether. Processed: 1.234 chunks (3,50%), ETA: 0:01:00, Rate: 7,5 cps, Current: 1, 2';
		expect(chunky.parseProgress(comma)[0]).toMatchObject({ chunks: 1234, percent: 3.5, rate: 7.5 });
		expect(chunky.parseProgress('No tasks running.')).toEqual([]);
	});

	it('reads the tasks Chunky saved, one folder per namespace, escapes and all', async () => {
		const instance = await server({
			'config/chunky/tasks/minecraft/overworld.properties':
				'#Chunky task\nworld=minecraft\\:overworld\ncancelled=false\ncenter-x=0.0\ncenter-z=-128.0\nradius=2500.0\nshape=circle\nchunks=4096\ntime=60000\n',
			'config/chunky/tasks/minecraft/the_end.properties': 'world=minecraft\\:the_end\ncancelled=true\nradius=500.0\nchunks=3969\n'
		});
		expect(await chunky.savedTasks(instance.path)).toEqual([
			{ world: 'minecraft:overworld', cancelled: false, shape: 'circle', centerX: 0, centerZ: -128, radius: 2500, chunks: 4096, time: 60000 },
			{ world: 'minecraft:the_end', cancelled: true, shape: 'square', centerX: 0, centerZ: 0, radius: 500, chunks: 3969, time: 0 }
		]);
	});

	it('starts with the whole selection in one command, and notices when Chunky asks to confirm', async () => {
		const instance = await server();
		rcon.answers['chunky start minecraft:overworld circle 100 -200 2500'] = '§2[Chunky]§r Task started in minecraft:overworld for the circle region centered at 100, -200 with radius 2,500.';
		const started = await chunky.startPregen(instance, { world: 'minecraft:overworld', shape: 'circle', centerX: 100, centerZ: -200, radius: 2500 });
		expect(started).toEqual({ text: 'Task started in minecraft:overworld for the circle region centered at 100, -200 with radius 2,500.', needsConfirm: false });

		rcon.answers['chunky start minecraft:overworld square 0 0 1000'] =
			"[Chunky] A task was already started for this world. To continue running it, type '/chunky continue'. To start a new task, type '/chunky confirm'.";
		expect((await chunky.startPregen(instance, { world: 'minecraft:overworld', shape: 'square', centerX: 0, centerZ: 0, radius: 1000 })).needsConfirm).toBe(true);
	});

	it('refuses selections that are not one, so nothing odd reaches a command', async () => {
		const instance = await server();
		const ok = { world: 'minecraft:overworld', shape: 'square' as const, centerX: 0, centerZ: 0, radius: 1000 };
		for (const bad of [{ world: 'overworld; stop' }, { world: 'Minecraft:Overworld' }, { radius: 8 }, { radius: 1.5 }, { centerX: 40_000_000 }]) {
			await expect(chunky.startPregen(instance, { ...ok, ...bad })).rejects.toThrow(chunky.ChunkyError);
		}
		expect(rcon.commands).toEqual([]);
	});

	it('confirms a cancel in the same go', async () => {
		const instance = await server();
		await chunky.cancelPregen(instance, 'minecraft:the_nether');
		await chunky.pausePregen(instance);
		expect(rcon.commands).toEqual(['chunky cancel minecraft:the_nether', 'chunky confirm', 'chunky pause']);
	});

	describe('pausing while players are online', () => {
		it('pauses what runs when someone joins, and continues only that once the server is empty', async () => {
			const instance = await server();
			chunky.setPausesForPlayers(instance.id, true);
			rcon.answers['chunky progress'] = RUNNING;

			await chunky.autoPauseForPlayers(instance);
			expect(rcon.commands).not.toContain('chunky pause minecraft:overworld');

			rcon.players = 1;
			await chunky.autoPauseForPlayers(instance);
			expect(rcon.commands).toContain('chunky pause minecraft:overworld');
			expect(chunky.pausedForPlayers(instance.id)).toEqual(['minecraft:overworld']);

			rcon.commands = [];
			rcon.answers['chunky progress'] = '[Chunky] No tasks running.';
			await chunky.autoPauseForPlayers(instance);
			expect(rcon.commands.filter((c) => c.startsWith('chunky ') && c !== 'chunky progress')).toEqual([]);

			rcon.players = 0;
			await chunky.autoPauseForPlayers(instance);
			expect(rcon.commands).toContain('chunky continue minecraft:overworld');
			expect(chunky.pausedForPlayers(instance.id)).toEqual([]);
		});

		it('never continues a task the user paused', async () => {
			const instance = await server({
				'config/chunky/tasks/minecraft/overworld.properties': 'world=minecraft\\:overworld\ncancelled=false\n'
			});
			chunky.setPausesForPlayers(instance.id, true);
			rcon.answers['chunky progress'] = '[Chunky] No tasks running.';
			await chunky.autoPauseForPlayers(instance);
			expect(rcon.commands.some((c) => c.startsWith('chunky continue'))).toBe(false);
		});

		it('stays out of it unless turned on, and when Chunky is not in English', async () => {
			const instance = await server({ 'config/chunky/config.json': '{"language": "de"}' });
			rcon.players = 1;
			rcon.answers['chunky progress'] = RUNNING;
			await chunky.autoPauseForPlayers(instance);
			chunky.setPausesForPlayers(instance.id, true);
			await chunky.autoPauseForPlayers(instance);
			expect(rcon.commands).toEqual([]);
		});
	});

	it('knows whether Chunky is installed', async () => {
		const instance = await server();
		const { writeJar } = await import('../helpers/fs');
		expect(await chunky.hasChunky(instance.path)).toBe(false);
		await writeJar(path.join(instance.path, 'mods'), 'Chunky-Fabric-1.4.40.jar', {
			'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'chunky', version: '1.4.40' })
		});
		expect(await chunky.hasChunky(instance.path)).toBe(true);
		await fs.rm(path.join(instance.path, 'mods'), { recursive: true });
		expect(await chunky.hasChunky(instance.path)).toBe(false);
	});
});
