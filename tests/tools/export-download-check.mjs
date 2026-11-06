#!/usr/bin/env node
/**
 * Runs a server's two exports in a real Firefox on a throwaway dev server: does the file come and
 * the page stay? The end of a task reloads the page's data, and Firefox ends a page's requests at
 * any navigation, one that turns out to be a download too (Chromium does not). On a small server
 * that reload is over too soon to be hit, so a proxy in front holds back its answer. With --drop
 * it cuts every reload off instead, once the page is up: a connection gone, which has to leave
 * the page as it is (keeppage.ts).
 *
 * Playwright is no dependency of this repo, so it goes outside it, with Firefox:
 *   npm i --prefix <dir> playwright
 *   PLAYWRIGHT_BROWSERS_PATH=<dir>/browsers <dir>/node_modules/.bin/playwright install firefox
 *   PLAYWRIGHT_DIR=<dir> PLAYWRIGHT_BROWSERS_PATH=<dir>/browsers node tests/tools/export-download-check.mjs <instance id> [dev server port, default 5199] [--drop]
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const { firefox } = createRequire(`${process.env.PLAYWRIGHT_DIR}/`)('playwright');
const drop = process.argv.includes('--drop');
const [id, port = '5199'] = process.argv.slice(2).filter((arg) => arg !== '--drop');
let dropping = false;

const proxy = http.createServer((req, res) => {
	if (dropping && req.url?.includes('__data.json')) return req.socket.destroy();
	const upstream = http.request({ host: 'localhost', port, method: req.method, path: req.url, headers: req.headers }, async (answer) => {
		if (req.url?.includes('__data.json')) await new Promise((done) => setTimeout(done, 1500));
		res.writeHead(answer.statusCode ?? 502, answer.headers);
		answer.pipe(res);
	});
	upstream.on('error', () => res.destroy());
	res.on('close', () => upstream.destroy());
	req.pipe(upstream);
});
await new Promise((listening) => proxy.listen(0, () => listening(null)));
const { port: proxyPort } = /** @type {import('node:net').AddressInfo} */ (proxy.address());

const browser = await firefox.launch();
let failed = false;
for (const path of ['export', 'export/server']) {
	const page = await browser.newPage({ acceptDownloads: true });
	page.on('requestfailed', (/** @type {{ url(): string }} */ request) => {
		if (request.url().includes('__data.json')) console.log(`  cut off: ${new URL(request.url()).pathname}`);
	});
	await page.goto(`http://localhost:${proxyPort}/instances/${id}/${path}`, { waitUntil: 'load' });
	await page.waitForTimeout(3000);
	dropping = drop;
	const exportButton = page.getByRole('button', { name: 'Export', exact: true });
	const download = page.waitForEvent('download', { timeout: 60_000 });
	await exportButton.click();
	const file = (await download).suggestedFilename();
	await page.waitForTimeout(4000);
	const stayed = await exportButton.isVisible();
	const again = await page.getByRole('link', { name: /Download/ }).count();
	console.log(`${path}: saved ${file}, page ${stayed ? 'stayed' : 'LOST'}, download button ${again ? 'shown' : 'MISSING'}`);
	if (!stayed || !again) failed = true;
	dropping = false;
	await page.close();
}
await browser.close();
proxy.closeAllConnections();
proxy.close();
process.exit(failed ? 1 : 0);
