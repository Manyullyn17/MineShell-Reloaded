#!/usr/bin/env node
/**
 * Every page of a running MineShell, each sub-tab of it too, at one width:
 * a picture of each, and (with --overflow) what reaches past the right edge.
 * For looking over the whole interface after a change, on a throwaway server
 * (the screenshot world: `npm run screenshots -- --serve`, port 5198).
 *
 *   node tests/tools/page-sweep.mjs <base url> <out dir> [--width 390] [--overflow] [--spill]
 *        [--cookie name=value] [--server id]... [--player id/uuid]... [--only text] [--jobs 4] [--resume]
 *
 * --server adds that server's pages (overview, console, logs, mods, world and
 * restore chunks, map, players, files and disk usage, settings tabs, exports),
 * --player a player page (server id/uuid). --only keeps pages whose path has
 * that text. Prints one line per page and sub-tab; with --overflow, the
 * elements past the edge under it, with --spill, text running out of its box
 * or cut off (pageshot.mjs). --cookie signs the sweep in as that session's
 * account (the long world, `npm run screenshots -- --long`, prints the owner's
 * and a restricted account's); the sign-in pages, the refusal page and a
 * missing page are swept too (signed in, the first two may redirect).
 *
 * --jobs N shoots N pages at once (default 4; each pageshot has a Chrome of its
 * own, and most of a shot is waiting for the page to settle). Each shot's
 * findings go in a .txt next to its picture, and report.txt holds them all in
 * page order at the end; --resume skips shots that have their .txt already, so a
 * sweep cut short goes on where it stopped.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const [base, out] = args;
if (!base || !out) {
	console.error('Usage: node tests/tools/page-sweep.mjs <base url> <out dir> [--width 390] [--overflow] [--spill] [--cookie name=value] [--server id]... [--player id/uuid]... [--only text] [--jobs 4] [--resume]');
	process.exit(1);
}
/** @param {string} name */
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const width = all('--width')[0] ?? '390';
const overflow = args.includes('--overflow');
const spill = args.includes('--spill');
const cookie = all('--cookie')[0];
const only = all('--only');
const jobs = Math.max(1, Number(all('--jobs')[0] ?? 4));
const resume = args.includes('--resume');
const pageshot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pageshot.mjs');

const pages = [
	'/',
	'/instances/new',
	'/tasks',
	// Settings tabs are sub-tabs: each page is listed once and its tabs are clicked through.
	'/settings',
	'/settings/defaults',
	'/settings/users',
	'/account',
	'/about',
	'/login',
	'/setup',
	'/denied',
	'/no-such-page',
	...all('--server').flatMap((id) => [
		`/instances/${id}`,
		`/instances/${id}/console`,
		`/instances/${id}/logs`,
		`/instances/${id}/mods`,
		`/instances/${id}/world`,
		`/instances/${id}/world/chunks`,
		`/instances/${id}/map`,
		`/instances/${id}/players`,
		`/instances/${id}/files`,
		`/instances/${id}/files/usage`,
		`/instances/${id}/settings`,
		`/instances/${id}/export`,
		`/instances/${id}/export/mods`,
		`/instances/${id}/export/server`,
		`/instances/${id}/no-such-page`
	]),
	...all('--player').map((p) => `/instances/${p.split('/')[0]}/players/${p.split('/')[1]}`)
].filter((p) => !only.length || only.some((o) => p.includes(o)));

fs.mkdirSync(out, { recursive: true });
const SETTLE = `new Promise((r) => setTimeout(r, 2500))`;
const COUNT_SUBTABS = `document.querySelectorAll('.subtabs > button, .subtabs > a').length`;

/** One pageshot run; its printed lines. @param {string} page @param {string} file @param {string[]} extra @returns {Promise<string[]>} */
function shoot(page, file, extra) {
	const run = [pageshot, `${base}${page}`, path.join(out, file), '--width', width, '--eval', SETTLE, ...extra, ...(overflow ? ['--overflow'] : []), ...(spill ? ['--spill'] : []), ...(cookie ? ['--cookie', cookie] : [])];
	return new Promise((resolve) => {
		execFile(process.execPath, run, { encoding: 'utf8', timeout: 120_000 }, (err, stdout, stderr) => {
			const why = err && (err.killed ? 'no picture within 2 minutes' : stderr.trim().split('\n').filter((l) => /Error|error/.test(l)).pop() ?? err.message.split('\n')[0]);
			resolve(err ? [`failed: ${why}`] : stdout.trim().split('\n'));
		});
	});
}

/** The lines worth showing: overflow findings and failures, not the picture's path. @param {string[]} lines */
const findings = (lines) => lines.filter((l) => !l.startsWith(out) && !/^(Nothing past the right edge|No text out of its box)/.test(l) && l !== 'true' && l !== 'undefined');

/**
 * A shot's report: its heading and findings, kept in `<name>.txt` (with the page's
 * sub-tab count on the first line of the page's own) so --resume can skip it.
 * A failed shot is not kept, so a resumed sweep tries it again.
 * @param {string} file @param {string} heading @param {string[]} extra @param {string} page
 */
async function result(page, file, heading, extra) {
	const kept = path.join(out, file.replace(/\.png$/, '.txt'));
	if (resume && fs.existsSync(kept)) return fs.readFileSync(kept, 'utf8').split('\n');
	const lines = await shoot(page, file, extra);
	const count = lines.find((l) => /^\d+$/.test(l)) ?? '0';
	const said = findings(lines).filter((l) => !/^\d+$/.test(l));
	const text = [count, `${heading}${said.length ? `\n  ${said.join('\n  ')}` : ''}`];
	if (!said.some((l) => l.startsWith('failed:'))) fs.writeFileSync(kept, text.join('\n'));
	return text;
}

/** @type {{ order: number, text: string }[]} */
const done = [];
/** @type {(() => Promise<void>)[]} */
const queue = [];
const report = (/** @type {number} */ order, /** @type {string} */ text) => {
	done.push({ order, text });
	console.log(text);
};
pages.forEach((page, i) => {
	const name = page.replace(/^\//, '').replace(/[/?=]+/g, '_') || 'servers';
	queue.push(async () => {
		const [count, text] = await result(page, `${name}.png`, page, ['--eval', COUNT_SUBTABS]);
		report(i * 100, text);
		// The first sub-tab is what the page opens on; the others are switched to in place.
		for (let n = 2; n <= Number(count); n++) {
			queue.push(async () => {
				const [, tab] = await result(page, `${name}_tab${n}.png`, `${page} (sub-tab ${n})`, ['--click', `.subtabs > :nth-child(${n})`]);
				report(i * 100 + n, tab);
			});
		}
	});
});

// A page's sub-tabs are queued once it has been shot: a worker that finds the
// queue empty waits while others are still on a page.
let busy = 0;
async function worker() {
	while (queue.length || busy) {
		const job = queue.shift();
		if (!job) {
			await new Promise((r) => setTimeout(r, 200));
			continue;
		}
		busy++;
		await job();
		busy--;
	}
}
await Promise.all(Array.from({ length: jobs }, worker));
done.sort((a, b) => a.order - b.order);
fs.writeFileSync(path.join(out, 'report.txt'), done.map((d) => d.text).join('\n') + '\n');
console.log(`\n${done.length} shots; report in ${path.join(out, 'report.txt')}`);
