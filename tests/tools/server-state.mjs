#!/usr/bin/env node
/**
 * What a running MineShell's overview says about one server, as one line of JSON: running,
 * starting, how long ago it started, "restart to apply", stuck starting. For checks on a real
 * machine that look at what the page would show rather than at systemd (MINESHELL_AUTH=off).
 *
 *   node tests/tools/server-state.mjs <server id> [address, default http://127.0.0.1:5199]
 *
 * Needs devalue, like act.mjs (in an installed MineShell's release folder: `npm i --no-save
 * devalue` there).
 *
 * Made for the clock check (docs/notes/runtime.md, "Unit start times"): with a server running,
 * `sudo timedatectl set-ntp false; sudo date -s '+1 hour'`, Restart it, and read this a few
 * seconds later. Up to 1.3.0-beta.2 it said `startingSinceAgoS: 3604` with `stuckSince` set
 * (stuck starting, four seconds into the start); it should say 4 and null.
 */
import { createRequire } from 'node:module';

const { unflatten } = createRequire(import.meta.url)('devalue');
const [id, address = 'http://127.0.0.1:5199'] = process.argv.slice(2);
if (!id) {
	console.error('usage: node tests/tools/server-state.mjs <server id> [address]');
	process.exit(1);
}
const res = await fetch(`${address}/instances/${id}/__data.json`);
if (!res.ok) {
	console.error(`${res.status} from ${address}/instances/${id}`);
	process.exit(1);
}
// The first line is the data; what the page streams in later follows on lines of its own.
const body = JSON.parse((await res.text()).split('\n')[0]);
/** @param {number | null | undefined} at */
const ago = (at) => (at ? Math.round((Date.now() - at) / 1000) : null);
const out = {};
for (const node of body.nodes) {
	if (node?.type !== 'data') continue;
	const data = unflatten(node.data, { Promise: () => null });
	if (data.phase !== undefined) Object.assign(out, { running: data.running, phase: data.phase });
	if (data.summary) {
		Object.assign(out, {
			uptimeS: Math.round(data.summary.uptimeMs / 1000),
			startedAgoS: ago(data.summary.startedAt),
			startingSinceAgoS: ago(data.summary.startingSince),
			restartToApply: data.summary.restartToApply,
			stuckSince: data.stuckSince ?? null
		});
	}
}
console.log(JSON.stringify(out));
