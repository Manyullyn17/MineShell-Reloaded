import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET } from './+server';
import { mapToken } from '#lib/server/mapframe.js';
import { webRoot } from '#lib/server/worldmap.js';
import { createInstance } from '../../../../../../tests/helpers/instances';
import { call } from '../../../../../../tests/helpers/routes';

/** The rendered map (BlueMap's web app), served sandboxed under the Map tab's token (mapframe.ts). */

async function setup() {
	const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
	const root = webRoot(instance.id);
	await fs.mkdir(path.join(root, 'assets'), { recursive: true });
	await fs.writeFile(path.join(root, 'index.html'), '<!DOCTYPE html><html><head><title>BlueMap</title></head></html>');
	await fs.writeFile(path.join(root, 'assets', 'app.js'), 'console.log(1)');
	const token = mapToken(null, instance.id);
	const at = (rel: string) => ({ params: { token, path: rel }, url: `http://localhost/maps/${token}/view/${rel}` });
	return { token, at };
}

describe('the rendered map', () => {
	it('is served sandboxed, its page with the storage shim and its files as they are', async () => {
		const { at } = await setup();
		const page = await call(GET, at(''));
		expect(page.headers.get('content-security-policy')).toBe("sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'");
		expect(page.headers.get('access-control-allow-origin')).toBe('*');
		expect(await page.text()).toMatch(/^<!DOCTYPE html><html><head><script>[\s\S]*<title>BlueMap<\/title>/);

		const script = await call(GET, at('assets/app.js'));
		expect(script.headers.get('content-security-policy')).toMatch(/^sandbox /);
		expect(await script.text()).toBe('console.log(1)');
	});

	it('is refused without a token that counts', async () => {
		await setup();
		const token = 'B'.repeat(43);
		expect((await call(GET, { params: { token, path: '' }, url: `http://localhost/maps/${token}/view/` })).status).toBe(403);
	});
});
