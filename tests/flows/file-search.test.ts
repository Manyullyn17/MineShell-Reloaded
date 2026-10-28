import { describe, expect, it } from 'vitest';

/** Search in files (filesearch.ts): which files are read, what a hit holds. */

const { searchFiles } = await import('#lib/server/filesearch.js');
const { createInstance } = await import('../helpers/instances');

const server = () =>
	createInstance(
		{ modloader: 'neoforge', minecraftVersion: '1.21.1' },
		{
			'server.properties': 'level-name=world\nmax-tick-time=60000\n',
			'world/level.dat': 'x',
			'world/serverconfig/create-server.toml': '[kinetics]\n\tmaxBeltLength = 20\n',
			'world/data/raids.dat': 'maxBeltLength',
			'world/notes.txt': 'maxBeltLength at the world top',
			'config/create-common.toml': '# Belts\nmaxBeltLength = 20\n',
			'config/sub/deep.json': '{\n  "MaxBeltLength": 40\n}\n',
			'config/binary.cfg': Buffer.from([0x6d, 0x61, 0x78, 0x00, 0x42, 0x65, 0x6c, 0x74, 0x4c, 0x65, 0x6e, 0x67, 0x74, 0x68]),
			'kubejs/server_scripts/belts.js': `ServerEvents.tags('item', e => {})\n// maxBeltLength ${'x'.repeat(400)} end\n`,
			'mods/create.jar': 'maxBeltLength',
			'logs/latest.log': 'maxBeltLength',
			'old-configs/2026-10-01/create-common.toml': 'maxBeltLength = 10',
			'.mineshell/snapshots/a/create.toml': 'maxBeltLength',
			'scripts/belts.zs': 'recipes.remove(<create:belt>); // maxBeltLength'
		}
	);

describe('search in files', () => {
	it('finds the line in configs, scripts and a world serverconfig, case aside', async () => {
		const instance = await server();
		const found = await searchFiles(instance.path, 'maxbeltlength');
		expect(found.files.map((f) => [f.path, f.lines.map((l) => l.n)])).toEqual([
			['config/create-common.toml', [2]],
			['config/sub/deep.json', [2]],
			['kubejs/server_scripts/belts.js', [2]],
			['scripts/belts.zs', [1]],
			['world/serverconfig/create-server.toml', [2]]
		]);
		expect(found.total).toBe(5);
		expect(found.partial).toBe(false);
	});

	it('leaves out mods, logs, old configs, MineShell, binary files and the rest of worlds', async () => {
		const instance = await server();
		const paths = (await searchFiles(instance.path, 'maxBeltLength')).files.map((f) => f.path);
		for (const left of ['mods/create.jar', 'logs/latest.log', 'old-configs/2026-10-01/create-common.toml', '.mineshell/snapshots/a/create.toml', 'config/binary.cfg', 'world/notes.txt', 'world/data/raids.dat']) {
			expect(paths).not.toContain(left);
		}
	});

	it('finds files and folders by name, jars and logs too, but not inside worlds or MineShell', async () => {
		const instance = await server();
		expect((await searchFiles(instance.path, 'CREATE')).names).toEqual([
			{ path: 'config/create-common.toml', isDirectory: false },
			{ path: 'mods/create.jar', isDirectory: false },
			{ path: 'world/serverconfig/create-server.toml', isDirectory: false }
		]);
		expect((await searchFiles(instance.path, 'server_scr')).names).toEqual([{ path: 'kubejs/server_scripts', isDirectory: true }]);
		expect((await searchFiles(instance.path, 'raids')).names).toEqual([]);
	});

	it('cuts a long line down to the part around the match', async () => {
		const instance = await server();
		const [hit] = (await searchFiles(instance.path, 'maxBeltLength', 'kubejs')).files;
		expect(hit.lines[0].text.length).toBeLessThan(260);
		expect(hit.lines[0].text).toContain('maxBeltLength');
		expect(hit.lines[0].text.endsWith('…')).toBe(true);
	});

	it('searches only the folder asked for, and refuses one outside the server', async () => {
		const instance = await server();
		expect((await searchFiles(instance.path, 'maxBeltLength', 'config/sub')).files.map((f) => f.path)).toEqual(['config/sub/deep.json']);
		await expect(searchFiles(instance.path, 'maxBeltLength', '../..')).rejects.toThrow();
		expect((await searchFiles(instance.path, 'm')).files).toEqual([]);
	});

	it('stops when it has been reading too long, marked partial', async () => {
		const instance = await server();
		let t = 0;
		const found = await searchFiles(instance.path, 'maxBeltLength', '', () => (t += 3000));
		expect(found.partial).toBe(true);
	});
});
