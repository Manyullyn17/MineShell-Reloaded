import { describe, expect, it } from 'vitest';
import { accepts } from './dropzone';

const file = (name: string, type = '') => new File(['x'], name, { type });

describe('which dropped files an input takes', () => {
	it('matches extensions, MIME types and wildcards as the browser does', () => {
		expect(accepts('.zip,application/zip', file('World.ZIP'))).toBe(true);
		expect(accepts('.zip,application/zip', file('world', 'application/zip'))).toBe(true);
		expect(accepts('.zip,application/zip', file('photo.png', 'image/png'))).toBe(false);
		expect(accepts('image/*', file('icon.webp', 'image/webp'))).toBe(true);
		expect(accepts('.mrpack,.zip', file('pack.mrpack'))).toBe(true);
		expect(accepts('.jar', file('mod.jar.disabled'))).toBe(false);
	});

	it('takes anything when the input names nothing', () => {
		expect(accepts('', file('notes.txt'))).toBe(true);
	});
});
