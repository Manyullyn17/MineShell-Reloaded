import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({
	commands: [] as string[],
	answers: {} as Record<string, string>,
	players: 0
}));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map((c) =>
			c === 'list' ? `There are ${rcon.players} of a max of 20 players online: ${rcon.players ? 'Alex' : ''}` : (rcon.answers[c] ?? '')
		);
	})
}));

const chunky = await import('#lib/server/chunky.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

/** As Chunky sends it over RCON: its prefix in colour, then task_update. */
const RUNNING =
	'§2[Chunky]§r Task running for minecraft:overworld. Processed: 12,345 chunks (12.34%), ETA: 1:05:12, Rate: 45.6 cps, Current: 12, -34';

async function server(files: Parameters<typeof createInstance>[1] = {}) {
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
			{ world: 'minecraft:overworld', cancelled: false, shape: 'circle', centerX: 0, centerZ: -128, radius: 2500, radiusZ: null, chunks: 4096, time: 60000 },
			{ world: 'minecraft:the_end', cancelled: true, shape: 'square', centerX: 0, centerZ: 0, radius: 500, radiusZ: null, chunks: 3969, time: 0 }
		]);
	});

	it('reads Chunky 1.2 (Minecraft 1.16 to 1.19.2), which keeps its language and tasks in config/chunky.json', async () => {
		const instance = await server({
			'config/chunky.json': JSON.stringify({
				version: 1,
				language: 'de',
				continueOnRestart: false,
				tasks: {
					'minecraft:overworld': { cancelled: false, radius: 3000.0, radiusZ: 1500.0, centerX: 64.0, centerZ: 0.0, iterator: 'loop', shape: 'rectangle', count: 812, time: 9000 }
				}
			})
		});
		expect(await chunky.chunkyLanguage(instance.path)).toBe('de');
		expect(await chunky.savedTasks(instance.path)).toEqual([
			{ world: 'minecraft:overworld', cancelled: false, shape: 'rectangle', centerX: 64, centerZ: 0, radius: 3000, radiusZ: 1500, chunks: 812, time: 9000 }
		]);
		// Updated past 1.2: the new config wins, and its tasks come from their files.
		await fs.mkdir(path.join(instance.path, 'config/chunky'), { recursive: true });
		await fs.writeFile(path.join(instance.path, 'config/chunky/config.json'), JSON.stringify({ language: 'en' }));
		expect(await chunky.chunkyLanguage(instance.path)).toBe('en');
		expect(await chunky.savedTasks(instance.path)).toEqual([]);
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

	it('gives rectangles and ellipses both radii, east-west first', async () => {
		const instance = await server();
		await chunky.startPregen(instance, { world: 'minecraft:overworld', shape: 'ellipse', centerX: 5, centerZ: 6, radius: 3000, radiusZ: 1000 });
		expect(rcon.commands).toEqual(['chunky start minecraft:overworld ellipse 5 6 3000 1000']);
		await expect(chunky.startPregen(instance, { world: 'minecraft:overworld', shape: 'rectangle', centerX: 0, centerZ: 0, radius: 3000 })).rejects.toThrow(/radius/);
		await expect(chunky.startPregen(instance, { world: 'minecraft:overworld', shape: 'star' as never, centerX: 0, centerZ: 0, radius: 3000 })).rejects.toThrow(/rectangle/);
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

	it('writes continueOnRestart into the config Chunky made, on unless turned off, for 1.3 and 1.2 alike', async () => {
		const { writeJar } = await import('../helpers/fs');
		const read = async (instance: { path: string }, file: string) => JSON.parse(await fs.readFile(path.join(instance.path, file), 'utf8'));
		const withChunky = async (files: Record<string, string>) => {
			const instance = await server(files);
			await writeJar(path.join(instance.path, 'mods'), 'Chunky-Fabric-1.4.40.jar', {
				'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'chunky', version: '1.4.40' })
			});
			return instance;
		};

		const current = await withChunky({ 'config/chunky/config.json': JSON.stringify({ version: 2, language: 'en', continueOnRestart: false, updateInterval: 1 }) });
		expect(chunky.continuesOnRestart(current.id)).toBe(true);
		await chunky.applyChunkyConfig(current);
		expect(await read(current, 'config/chunky/config.json')).toEqual({ version: 2, language: 'en', continueOnRestart: true, updateInterval: 1 });
		await chunky.setContinuesOnRestart(current, false);
		expect((await read(current, 'config/chunky/config.json')).continueOnRestart).toBe(false);

		const legacy = await withChunky({ 'config/chunky.json': JSON.stringify({ version: 1, continueOnRestart: false, tasks: {} }) });
		await chunky.applyChunkyConfig(legacy);
		expect(await read(legacy, 'config/chunky.json')).toEqual({ version: 1, continueOnRestart: true, tasks: {} });

		// Before Chunky's first start there is no config to change; MineShell does not make one.
		const fresh = await withChunky({});
		await chunky.applyChunkyConfig(fresh);
		expect(await chunky.chunkyConfigFile(fresh.path)).toBeNull();
	});

	it('reads the world border to pre-generate up to: level.dat before 1.21.11, then a file per dimension', async () => {
		const { writeNbt } = await import('#lib/server/nbt.js');
		const { worldBorder, worldSpawn } = await import('#lib/server/world.js');
		const { listDimensions } = await import('#lib/server/dimensions.js');
		const double = (value: number) => ({ type: 'double' as const, value });
		const nbt = (outer: string, fields: [string, number][]) =>
			writeNbt({ name: '', gzipped: true, root: { type: 'compound', value: [[outer, { type: 'compound', value: fields.map(([k, v]) => [k, double(v)]) }]] } });
		const region = { 'world/region/r.0.0.mca': '', 'world/DIM-1/region/r.0.0.mca': '' };

		const old = await server({ ...region, 'world/level.dat': nbt('Data', [['BorderCenterX', 200.5], ['BorderCenterZ', -100], ['BorderSize', 3000]]) });
		const [overworld, nether] = await listDimensions(old.path);
		expect(await worldBorder(old.path, overworld)).toEqual({ x: 201, z: -100, radius: 1500 });
		// What the Nether got from it before 1.21.11 is not guessed at.
		expect(await worldBorder(old.path, nether)).toBeNull();

		const recent = await server({
			...region,
			'world/level.dat': nbt('Data', []),
			'world/data/world_border.dat': nbt('data', [['center_x', 0], ['center_z', 0], ['size', 59999968]]),
			'world/DIM-1/data/world_border.dat': nbt('data', [['center_x', 16], ['center_z', 32], ['size', 2000]])
		});
		const [overworld2, nether2] = await listDimensions(recent.path);
		// Minecraft's default width is no border at all.
		expect(await worldBorder(recent.path, overworld2)).toBeNull();
		expect(await worldBorder(recent.path, nether2)).toEqual({ x: 16, z: 32, radius: 1000 });
		expect(await worldSpawn(recent.path)).toBeNull();

		// Minecraft 26: the overworld in dimensions/, and the file under data/minecraft/.
		const o = 'world/dimensions/minecraft/overworld';
		const modern = await server({
			[`${o}/region/r.0.0.mca`]: '',
			'world/level.dat': nbt('Data', []),
			[`${o}/data/minecraft/world_border.dat`]: nbt('data', [['center_x', -64], ['center_z', 128], ['size', 4000]])
		});
		const [overworld3] = await listDimensions(modern.path);
		expect(await worldBorder(modern.path, overworld3)).toEqual({ x: -64, z: 128, radius: 2000 });
	});
});
