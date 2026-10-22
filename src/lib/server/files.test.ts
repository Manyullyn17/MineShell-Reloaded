import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveUpload, uploadPath, writeTextFile } from './files';
import { tempDir } from '../../../tests/helpers/fs';

describe('uploadPath', () => {
	it('keeps the folders of a dropped folder, and only the name of a picked file', () => {
		expect(uploadPath('config', 'jei/settings.toml', true)).toBe('config/jei/settings.toml');
		expect(uploadPath('', 'mods/a.jar', true)).toBe('mods/a.jar');
		expect(uploadPath('config', 'jei/settings.toml', false)).toBe('config/settings.toml');
	});

	it('never steps out of the folders a file was dropped with', () => {
		expect(() => uploadPath('config', '../server.properties', true)).toThrow();
		expect(() => uploadPath('config', 'a/../../b', true)).toThrow();
		expect(uploadPath('config', './a//b', true)).toBe('config/a/b');
	});
});

describe('saving a file', () => {
	it('replaces it instead of writing into it, so its other names keep the old contents', async () => {
		const root = await tempDir('files-');
		await fs.writeFile(path.join(root, 'a.json'), '{"old": true}');
		// A snapshot sharing the file, as hard-linked snapshots do.
		await fs.link(path.join(root, 'a.json'), path.join(root, 'shared.json'));
		await writeTextFile(root, 'a.json', '{"new": true}');
		expect(await fs.readFile(path.join(root, 'a.json'), 'utf8')).toBe('{"new": true}');
		expect(await fs.readFile(path.join(root, 'shared.json'), 'utf8')).toBe('{"old": true}');

		await fs.link(path.join(root, 'a.json'), path.join(root, 'shared2.json'));
		await saveUpload(root, 'a.json', new File(['uploaded'], 'a.json'));
		expect(await fs.readFile(path.join(root, 'shared2.json'), 'utf8')).toBe('{"new": true}');
		expect(await fs.readdir(root)).toEqual(['a.json', 'shared.json', 'shared2.json']);
	});

	it('keeps the permissions it had, and writes through a symbolic link', async () => {
		const root = await tempDir('files-');
		await fs.writeFile(path.join(root, 'run.sh'), 'java -jar old.jar\n', { mode: 0o755 });
		await writeTextFile(root, 'run.sh', 'java -jar new.jar\r\n');
		expect((await fs.stat(path.join(root, 'run.sh'))).mode & 0o777).toBe(0o755);

		await fs.writeFile(path.join(root, 'real.txt'), 'old');
		await fs.symlink('real.txt', path.join(root, 'link.txt'));
		await writeTextFile(root, 'link.txt', 'new');
		expect((await fs.lstat(path.join(root, 'link.txt'))).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(path.join(root, 'real.txt'), 'utf8')).toBe('new');
	});
});
