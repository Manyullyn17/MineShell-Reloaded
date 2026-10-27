#!/usr/bin/env node
/**
 * Every page of a running MineShell, each sub-tab of it too, at one width:
 * a picture of each, and (with --overflow) what reaches past the right edge.
 * For looking over the whole interface after a change, on a throwaway server
 * (the screenshot world: `npm run screenshots -- --serve`, port 5198).
 *
 *   node tests/tools/page-sweep.mjs <base url> <out dir> [--width 390] [--overflow]
 *        [--server id]... [--player id/uuid]... [--only text]
 *
 * --server adds that server's pages (overview, console, logs, mods, world and
 * restore chunks, map, players, files and disk usage, settings tabs, exports),
 * --player a player page (server id/uuid). --only keeps pages whose path has
 * that text. Prints one line per page and sub-tab; with --overflow, the
 * elements past the edge under it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const [base, out] = args;
if (!base || !out) {
	console.error('Usage: node tests/tools/page-sweep.mjs <base url> <out dir> [--width 390] [--overflow] [--server id]... [--player id/uuid]... [--only text]');
	process.exit(1);
}
/** @param {string} name */
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const width = all('--width')[0] ?? '390';
const overflow = args.includes('--overflow');
const only = all('--only');
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
		`/instances/${id}/export/server`
	]),
	...all('--player').map((p) => `/instances/${p.split('/')[0]}/players/${p.split('/')[1]}`)
].filter((p) => !only.length || only.some((o) => p.includes(o)));

fs.mkdirSync(out, { recursive: true });
const SETTLE = `new Promise((r) => setTimeout(r, 2500))`;
const COUNT_SUBTABS = `document.querySelectorAll('.subtabs > button, .subtabs > a').length`;

/** One pageshot run; its printed lines. @param {string} page @param {string} file @param {string[]} extra */
function shoot(page, file, extra) {
	const run = [pageshot, `${base}${page}`, path.join(out, file), '--width', width, '--eval', SETTLE, ...extra, ...(overflow ? ['--overflow'] : [])];
	try {
		return execFileSync(process.execPath, run, { encoding: 'utf8', timeout: 120_000 }).trim().split('\n');
	} catch (err) {
		return [`failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`];
	}
}

/** The lines worth showing: overflow findings and failures, not the picture's path. @param {string[]} lines */
const findings = (lines) => lines.filter((l) => !l.startsWith(out) && !/^Nothing past the right edge/.test(l) && l !== 'true' && l !== 'undefined');

for (const page of pages) {
	const name = page.replace(/^\//, '').replace(/[/?=]+/g, '_') || 'servers';
	const first = shoot(page, `${name}.png`, ['--eval', COUNT_SUBTABS]);
	const subtabs = Number(first.find((l) => /^\d+$/.test(l)) ?? 0);
	const said = findings(first).filter((l) => !/^\d+$/.test(l));
	console.log(`${page}${said.length ? `\n  ${said.join('\n  ')}` : ''}`);
	// The first sub-tab is what the page opens on; the others are switched to in place.
	for (let n = 2; n <= subtabs; n++) {
		const lines = findings(shoot(page, `${name}_tab${n}.png`, ['--click', `.subtabs > :nth-child(${n})`]));
		console.log(`${page} (sub-tab ${n})${lines.length ? `\n  ${lines.join('\n  ')}` : ''}`);
	}
}
