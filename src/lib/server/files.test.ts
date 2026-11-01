import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachment, PathEscapeError, safeJoin, saveUpload, uploadPath, writeTextFile } from './files';
import { tempDir } from '../../../tests/helpers/fs';

describe('a download\'s name', () => {
	it('carries the real name in filename*, and a plain one in filename', () => {
		expect(attachment('My Server-world.zip')).toBe(`attachment; filename="My Server-world.zip"; filename*=UTF-8''My%20Server-world.zip`);
		expect(attachment('Größe "1" 100%.txt')).toBe(`attachment; filename="Gr__e _1_ 100_.txt"; filename*=UTF-8''Gr%C3%B6%C3%9Fe%20%221%22%20100%25.txt`);
		expect(attachment("it's (1).txt")).toContain(`filename*=UTF-8''it%27s%20%281%29.txt`);
	});
});

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

describe('symbolic links in a server folder', () => {
	it('are followed while they stay inside it, and refused once they lead out', async () => {
		const root = await tempDir('files-');
		const outside = await tempDir('outside-');
		await fs.writeFile(path.join(outside, 'secret.key'), 'secret');
		await fs.mkdir(path.join(root, 'logs'));
		await fs.writeFile(path.join(root, 'real.txt'), 'mine');
		await fs.symlink('../real.txt', path.join(root, 'logs', 'inside.txt'));
		// What a mod could leave behind for MineShell to read, share or overwrite.
		await fs.symlink(path.join(outside, 'secret.key'), path.join(root, 'logs', 'latest.log'));
		await fs.symlink(outside, path.join(root, 'elsewhere'));
		await fs.symlink(path.join(outside, 'not-yet.service'), path.join(root, 'dangling.txt'));

		expect(safeJoin(root, 'logs/inside.txt')).toBe(path.join(root, 'logs', 'inside.txt'));
		expect(safeJoin(root, 'logs/new.txt')).toBe(path.join(root, 'logs', 'new.txt'));
		expect(() => safeJoin(root, 'logs/latest.log')).toThrow(PathEscapeError);
		expect(() => safeJoin(root, 'elsewhere/secret.key')).toThrow(PathEscapeError);
		expect(() => safeJoin(root, 'elsewhere/new-file')).toThrow(PathEscapeError);
		// Writing through it would create the file it names.
		await expect(writeTextFile(root, 'dangling.txt', 'x')).rejects.toThrow(PathEscapeError);
		await expect(fs.access(path.join(outside, 'not-yet.service'))).rejects.toThrow();
		expect(await fs.readFile(path.join(outside, 'secret.key'), 'utf8')).toBe('secret');
	});

	it('still work when the server folder itself is reached through a link', async () => {
		const real = await tempDir('files-');
		const parent = await tempDir('link-');
		await fs.writeFile(path.join(real, 'a.txt'), 'a');
		await fs.symlink(real, path.join(parent, 'server'));
		expect(safeJoin(path.join(parent, 'server'), 'a.txt')).toBe(path.join(parent, 'server', 'a.txt'));
	});
});
