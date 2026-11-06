import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveFile } from './savefile.js';

describe('saveFile', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('clicks a download link, keeping the name the response gives', () => {
		const link = { href: '', download: 'x', click: vi.fn() };
		vi.stubGlobal('document', { createElement: () => link });
		saveFile('/api/instances/a/export?task=1');
		expect(link.href).toBe('/api/instances/a/export?task=1');
		expect(link.download).toBe('');
		expect(link.click).toHaveBeenCalledOnce();
	});

	// The task's end also reloads the page's data, and Firefox ended that request at the
	// navigation: the file came, and the page turned into a 500.
	it.each(['export', 'export/server'])('%s saves without navigating', (page) => {
		const source = fs.readFileSync(`src/routes/instances/[id]/${page}/+page.svelte`, 'utf8');
		expect(source).toContain('saveFile(download)');
		expect(source).not.toContain('location.assign');
	});
});
