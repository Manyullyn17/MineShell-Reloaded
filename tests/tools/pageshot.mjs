#!/usr/bin/env node
/**
 * A screenshot of a page once it has finished loading in the browser, for
 * checking UI changes on a throwaway dev server. Chrome's own --screenshot
 * fires at the load event, before the page's fetches (version lists,
 * previews, streamed data) have answered; this drives Chrome over its
 * DevTools protocol and waits for a text to appear instead.
 *
 *   node tests/tools/pageshot.mjs <url> <out.png> [options]
 *     --width <px>       viewport width (default 1280; 390 for a phone)
 *     --wait-for <text>  wait until the page shows this text (default: 2 s after load)
 *     --timeout <ms>     give up waiting after this long (default 30000), then shoot anyway
 *     --overflow         also list elements reaching past the viewport's right edge
 *     --click <selector> once loaded, click the first element matching this CSS selector;
 *                        --wait-for then waits for what the click brings
 *     --dialog <answer>  accept | dismiss a confirm() the page opens (default accept);
 *                        its text is printed
 *
 * The whole page is captured (up to 4000 px tall). Chromium: $CHROME, else
 * Playwright's under ~/.cache/ms-playwright, else chromium/google-chrome on
 * the PATH (as tests/itemicons/check.ts finds it).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
/** @param {string} name @param {string | null} fallback */
const option = (name, fallback) => {
	const at = args.indexOf(name);
	if (at < 0) return fallback;
	const [value] = args.splice(at, 2).slice(1);
	return value;
};
/** @param {string} name */
const flag = (name) => {
	const at = args.indexOf(name);
	if (at >= 0) args.splice(at, 1);
	return at >= 0;
};
const width = Number(option('--width', '1280'));
const waitFor = option('--wait-for', null);
const timeout = Number(option('--timeout', '30000'));
const overflow = flag('--overflow');
const click = option('--click', null);
const dialog = option('--dialog', 'accept');
const [url, out] = args;
if (!url || !out) {
	console.error('Usage: node tests/tools/pageshot.mjs <url> <out.png> [--width px] [--wait-for text] [--timeout ms] [--overflow] [--click selector] [--dialog accept|dismiss]');
	process.exit(1);
}

async function chromium() {
	if (process.env.CHROME) return process.env.CHROME;
	const home = os.homedir();
	for (const pattern of [`${home}/.cache/ms-playwright/chromium_headless_shell-*/*/headless_shell`, `${home}/.cache/ms-playwright/chromium-*/*/chrome`]) {
		const [found] = await Array.fromAsync(fs.glob(pattern));
		if (found) return found;
	}
	for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
		for (const dir of (process.env.PATH ?? '').split(':')) {
			const file = path.join(dir, name);
			if (await fs.access(file).then(() => true, () => false)) return file;
		}
	}
	throw new Error('No Chromium: set CHROME, or install one (npx playwright install chromium-headless-shell).');
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pageshot-'));
const port = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(await chromium(), ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},1200`, 'about:blank'], { stdio: 'ignore' });

try {
	let targets = null;
	for (let i = 0; i < 50 && !targets; i++) {
		targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json(), () => null);
		if (!targets) await sleep(200);
	}
	if (!targets) throw new Error('Chromium did not open its DevTools port.');
	const ws = new WebSocket(targets.find((/** @type {{ type: string }} */ t) => t.type === 'page').webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve);
		ws.addEventListener('error', reject);
	});
	let next = 0;
	const pending = new Map();
	ws.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	});
	/** @param {string} method @param {object} [params] @returns {Promise<any>} */
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const id = ++next;
			pending.set(id, resolve);
			ws.send(JSON.stringify({ id, method, params }));
		});
	/** @param {string} expression */
	const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

	ws.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		if (message.method !== 'Page.javascriptDialogOpening') return;
		console.log(`Dialog (${dialog}ed): ${message.params.message}`);
		void send('Page.handleJavaScriptDialog', { accept: dialog === 'accept' });
	});

	await send('Page.enable');
	await send('Page.navigate', { url });
	let found = !waitFor;
	const deadline = Date.now() + timeout;
	if (click) {
		while (Date.now() < deadline && (await evaluate('document.readyState')) !== 'complete') await sleep(200);
		await sleep(2000);
		const clicked = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(click)}); if (!e) return false; e.click(); return true; })()`);
		if (!clicked) console.log(`Nothing matches ${click}.`);
	}
	if (waitFor) {
		while (Date.now() < deadline && !found) {
			found = await evaluate(`!!document.body && document.body.innerText.includes(${JSON.stringify(waitFor)})`);
			if (!found) await sleep(500);
		}
	} else if (!click) {
		while (Date.now() < deadline && (await evaluate('document.readyState')) !== 'complete') await sleep(200);
		await sleep(2000);
	}
	await sleep(500);

	if (overflow) {
		const wide = await evaluate(`[...document.querySelectorAll('body *')]
			.filter((e) => {
				const r = e.getBoundingClientRect();
				if (r.width === 0 || r.right <= innerWidth + 1) return false;
				// Inside a box that scrolls or clips sideways (a tab bar) is not past the page's edge.
				for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
					if (/auto|scroll|hidden|clip/.test(getComputedStyle(a).overflowX)) return false;
				}
				return true;
			})
			.slice(0, 40)
			.map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + ' right=' + Math.round(e.getBoundingClientRect().right))`);
		console.log(wide.length ? `Past the right edge (${width}px):\n  ${wide.join('\n  ')}` : `Nothing past the right edge at ${width}px.`);
	}

	const height = Math.min(await evaluate('document.documentElement.scrollHeight'), 4000);
	await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
	await sleep(300);
	const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
	await fs.writeFile(out, Buffer.from(shot.result.data, 'base64'));
	console.log(`${out}${found ? '' : ` (gave up waiting for "${waitFor}")`}`);
	ws.close();
} finally {
	chrome.kill();
	await fs.rm(profile, { recursive: true, force: true });
}
