#!/usr/bin/env node
/**
 * Stands in for Java on a throwaway server and prints a recorded run's console
 * at the pace it was recorded, then stays up like a started server: for seeing
 * what the console page does under a real big pack's startup (tens of
 * thousands of lines a second) without running the pack.
 *
 *   journalctl --user -u <unit> --invocation=<id> -o json > run.jsonl
 *   node tests/tools/console-replay.mjs run.jsonl [--speed 1] [--loop]
 *
 * Make it the server's Java: a script `exec node .../console-replay.mjs
 * /path/run.jsonl` pinned as the server's Java path (the unit passes Java's
 * arguments after it, which are ignored). `--speed 2` plays twice as fast,
 * `--loop` starts over after a pause instead of staying quiet.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
if (!file || file.startsWith('--')) {
	console.error('Usage: node tests/tools/console-replay.mjs <journal export.jsonl> [--speed n] [--loop]');
	process.exit(1);
}
const at = args.indexOf('--speed');
const speed = at >= 0 ? Number(args[at + 1]) || 1 : 1;
const loop = args.includes('--loop');

/** @type {{ at: number; text: string }[]} */
const entries = fs
	.readFileSync(file, 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	// journalctl gives a message with bytes it cannot show as UTF-8 as an array of numbers.
	.map((e) => ({ at: Number(e.__REALTIME_TIMESTAMP) / 1000, text: Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString() : String(e.MESSAGE ?? '') }));
if (!entries.length) throw new Error(`${file} holds no journal entries.`);

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Writes and waits for the pipe, so a burst is not all held in memory at once. @param {string} text */
const write = (text) => new Promise((resolve) => (process.stdout.write(text) ? resolve(undefined) : process.stdout.once('drain', resolve)));

do {
	const start = Date.now();
	const first = entries[0].at;
	let batch = '';
	for (const entry of entries) {
		const due = start + (entry.at - first) / speed;
		if (due > Date.now()) {
			if (batch) await write(batch);
			batch = '';
			await sleep(due - Date.now());
		}
		batch += entry.text + '\n';
	}
	if (batch) await write(batch);
	if (loop) await sleep(5000);
} while (loop);
// Up like a started server until stopped: a bare never-settling await ends Node with
// exit code 13 once nothing else is pending, which the unit takes for a crash.
setInterval(() => {}, 1 << 30);
