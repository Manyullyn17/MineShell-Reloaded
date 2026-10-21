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
 *     --height <px>      exactly this tall (default: the whole page, up to 4000 px)
 *     --wait-for <text>  wait until the page shows this text (default: 2 s after load)
 *     --timeout <ms>     give up waiting after this long (default 30000), then shoot anyway
 *     --overflow         also list elements reaching past the viewport's right edge
 *     --click <selector> once loaded, click the first element matching this CSS selector;
 *                        --wait-for then waits for what the click brings. Repeatable: the
 *                        clicks happen in order, half a second apart
 *     --eval <js>        once loaded, run this in the page (awaited) and print what it
 *                        returns as JSON: fill a field, read state. Repeatable, and runs in
 *                        order with the --clicks, half a second apart; each may take up to
 *                        --timeout
 *     --drag <x1,y1,x2,y2>  once loaded, drag with the left mouse button from one point of
 *                        the viewport to another, as real input (it reaches into frames too:
 *                        panning a map). Repeatable, in order with --click and --eval
 *     --dialog <answer>  accept | dismiss a confirm() the page opens (default accept);
 *                        its text is printed
 *     --element <selector>  capture only the first element matching this (plus a small
 *                        margin), at full size: one part of a long phone-width page
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
const fixedHeight = option('--height', null);
const element = option('--element', null);
const waitFor = option('--wait-for', null);
const timeout = Number(option('--timeout', '30000'));
const overflow = flag('--overflow');
/** Every --click and --eval, in order: a sub-tab, then a button inside it. */
const steps = [];
for (let at = 0; at < args.length; ) {
	if (args[at] === '--click' || args[at] === '--eval' || args[at] === '--drag') steps.push({ kind: args[at].slice(2), value: args.splice(at, 2)[1] });
	else at++;
}
const click = steps.length > 0;
const dialog = option('--dialog', 'accept');
const [url, out] = args;
if (!url || !out) {
	console.error('Usage: node tests/tools/pageshot.mjs <url> <out.png> [--width px] [--wait-for text] [--timeout ms] [--overflow] [--click selector] [--eval js] [--drag x1,y1,x2,y2] [--dialog accept|dismiss]');
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
// Port 0: Chrome picks a free one and writes it into the profile. A random port
// could be another pageshot's when several ran at once, and this one then drove
// that Chrome and captured its page.
const chrome = spawn(await chromium(), ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${fixedHeight ?? 1200}`, 'about:blank'], { stdio: 'ignore' });

try {
	let targets = null;
	for (let i = 0; i < 50 && !targets; i++) {
		const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0];
		if (port) targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json(), () => null);
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
	/**
	 * One DevTools call. Chrome can leave one unanswered (a reload replacing the
	 * page mid-call), which used to hang the tool for good: give up after 20 s,
	 * or `limit` ms (an --eval that waits on purpose gets --timeout).
	 * @param {string} method @param {object} [params] @param {number} [limit] @returns {Promise<any>}
	 */
	const send = (method, params = {}, limit = 20000) =>
		new Promise((resolve, reject) => {
			const id = ++next;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Chrome did not answer ${method} within ${limit / 1000} s.`));
			}, limit);
			pending.set(id, (/** @type {any} */ message) => {
				clearTimeout(timer);
				resolve(message);
			});
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
		for (const [i, step] of steps.entries()) {
			if (i > 0) await sleep(500);
			if (step.kind === 'eval') {
				const answer = await send('Runtime.evaluate', { expression: step.value, returnByValue: true, awaitPromise: true }, Math.max(timeout, 20000));
				const thrown = answer.result?.exceptionDetails;
				console.log(thrown ? `--eval threw: ${thrown.exception?.description ?? thrown.text}` : JSON.stringify(answer.result?.result?.value));
				continue;
			}
			if (step.kind === 'drag') {
				const [x1, y1, x2, y2] = step.value.split(',').map(Number);
				/** @param {string} type @param {number} x @param {number} y */
				const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
				await mouse('mousePressed', x1, y1);
				for (let t = 1; t <= 10; t++) {
					await mouse('mouseMoved', x1 + ((x2 - x1) * t) / 10, y1 + ((y2 - y1) * t) / 10);
					await sleep(30);
				}
				await mouse('mouseReleased', x2, y2);
				continue;
			}
			const clicked = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(step.value)}); if (!e) return false; e.click(); return true; })()`);
			if (!clicked) console.log(`Nothing matches ${step.value}.`);
		}
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

	const height = fixedHeight ? Number(fixedHeight) : Math.min(await evaluate('document.documentElement.scrollHeight'), 4000);
	await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
	await sleep(300);
	let clip = fixedHeight ? { x: 0, y: 0, width, height, scale: 1 } : undefined;
	if (element) {
		const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(element)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
		if (box) {
			const margin = 8;
			const x = Math.max(0, box.x - margin);
			const y = Math.max(0, box.y - margin);
			clip = { x, y, width: Math.min(width - x, box.width + 2 * margin), height: box.height + 2 * margin, scale: 1 };
		} else console.log(`Nothing matches ${element}; the whole page is captured.`);
	}
	const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !fixedHeight || !!element, clip });
	await fs.writeFile(out, Buffer.from(shot.result.data, 'base64'));
	console.log(`${out}${found ? '' : ` (gave up waiting for "${waitFor}")`}`);
	ws.close();
} finally {
	// Chrome writes to its profile while it exits: wait for it before removing the folder.
	const exited = new Promise((resolve) => chrome.once('exit', resolve));
	chrome.kill();
	await Promise.race([exited, sleep(5000)]);
	await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
