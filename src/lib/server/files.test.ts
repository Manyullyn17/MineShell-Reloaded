import { describe, expect, it } from 'vitest';
import { uploadPath } from './files';

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
