#!/usr/bin/env node
/**
 * The data behind the "MineShell repo pulse" dashboard (a claude.ai artifact):
 * this repository's history as JSON files, one per source of the dashboard.
 *
 *   node tests/tools/repo-stats.mjs <out dir> [repo, default: this one]
 *
 *   commits.json      every commit on HEAD: author time, prefix type, lines, test touched, before/after v1.0.0
 *   releases.json     every tag in creation order and the commits it first held
 *   fix_release.json  each fix: the first tag holding it and the hours until then
 *   fix_origins.json  each fix: `git blame` on the src/ lines it changed or removed
 *                     (tests left out), the newest commit that wrote them and the gap
 *   areas.json        commits and changed lines per folder group, up to and after v1.0.0
 *   hotspots.json     the twelve files most commits touched, up to and after v1.0.0
 *   loc_weekly.json   lines of source, tests and Markdown at each week's last commit
 *   sessions.json     runs of commits with no pause over two hours
 *   ci_runs.json      completed GitHub Actions runs (`gh run list`, needs gh signed in)
 *
 * Reads only; about 15 s. The files are uploaded to the dashboard by Claude
 * (they replace its attached files), nothing here talks to it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const repo = process.argv[3] ?? path.resolve(import.meta.dirname, '../..');
if (!out) throw new Error('Usage: repo-stats.mjs <out dir> [repo]');
fs.mkdirSync(out, { recursive: true });

/** @param {string[]} args @param {string} [cmd] */
const run = (args, cmd = 'git') =>
	execFileSync(cmd, cmd === 'git' ? ['-C', repo, ...args] : args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
/** @param {string} name @param {unknown[]} rows */
function save(name, rows) {
	fs.writeFileSync(path.join(out, name), JSON.stringify(rows));
	console.log(name, rows.length);
}
/** Hours from one ISO time to another, to two decimals. @param {string} a @param {string} b */
const hours = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 36e3) / 100;

/** @param {string} subject */
function ctype(subject) {
	if (subject.startsWith('Merge ')) return 'merge';
	return /^([a-z]+)(\([^)]*\))?!?:/.exec(subject)?.[1] ?? 'unprefixed';
}
/** @param {string} p */
const isTest = (p) => p.startsWith('tests/') || p.includes('.test.');

// First match wins: more specific folders before their parents.
const AREAS = [
	['tests/', 'Tests and tooling'], ['docs/', 'Docs'], ['README', 'Docs'], ['CLAUDE.md', 'Docs'],
	['src/lib/server/access', 'Accounts and access'], ['src/routes/login', 'Accounts and access'],
	['src/routes/users', 'Accounts and access'],
	['src/lib/server/packs', 'Modpacks and mods'], ['src/lib/server/mods', 'Modpacks and mods'],
	['src/lib/server/loaders', 'Loaders and Java'], ['src/lib/server/java', 'Loaders and Java'],
	['src/lib/server/worlds', 'Worlds and backups'], ['src/lib/server/snapshots', 'Worlds and backups'],
	['src/lib/server/playerdata', 'Player data'], ['src/lib/server/nbt', 'Player data'],
	['src/lib/server', 'Server core (other)'],
	['src/routes', 'Pages and UI'], ['src/lib/shared', 'Pages and UI'], ['src/lib/components', 'Pages and UI'],
	['src/app.', 'Pages and UI'], ['src/', 'Server core (other)'],
	['package', 'Build and CI'], ['.github', 'Build and CI'], ['scripts/', 'Build and CI'],
	['vite.config', 'Build and CI'], ['.githooks', 'Build and CI']
];
/** @param {string} p */
const area = (p) => (isTest(p) ? 'Tests and tooling' : (AREAS.find(([pre]) => p.startsWith(pre))?.[1] ?? 'Other'));

// --- commits ---------------------------------------------------------------------
/** @param {string} p A numstat path, renames resolved to the new name */
const renamed = (p) => p.replace(/\{[^}]*=> ([^}]*)\}/g, '$1').split(' => ').pop() ?? p;

const commits = [];
for (const block of run(['log', '--format=%x01%H%x02%aI%x02%s%x02%P', '--numstat', 'HEAD']).split('\x01').slice(1)) {
	const [head, ...body] = block.split('\n');
	const [full, at, subject, parents] = head.split('\x02');
	const files = [];
	let ins = 0, del = 0;
	for (const line of body.filter(Boolean)) {
		const [a, d, p] = line.split('\t');
		files.push(renamed(p));
		if (a !== '-') {
			ins += Number(a);
			del += Number(d);
		}
	}
	const day = at.slice(0, 10);
	commits.push({
		full, at, day, hour: Number(at.slice(11, 13)),
		weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(day + 'T00:00:00Z').getUTCDay()],
		type: ctype(subject), subject, ins, del, files,
		tests: files.some(isTest), merge: parents.split(' ').length > 1,
		tag: /** @type {string | undefined} */ (undefined), released: /** @type {string | undefined} */ (undefined), period: ''
	});
}
commits.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const v1 = new Set(run(['rev-list', 'v1.0.0']).split('\n'));
const periodOf = (/** @type {string} */ h) => (v1.has(h) ? 'Up to 1.0.0' : 'After 1.0.0');
for (const c of commits) c.period = periodOf(c.full);
const byFull = new Map(commits.map((c) => [c.full, c]));

save('commits.json', commits.map((c) => ({
	hash: c.full.slice(0, 7), at: c.at, day: c.day, hour: c.hour, weekday: c.weekday, type: c.type, subject: c.subject,
	ins: c.ins, del: c.del, tests: c.tests, period: c.period, nfiles: c.files.length
})));

// --- releases and the wait from a fix to its release -------------------------------
const tags = run(['for-each-ref', '--sort=creatordate', '--format=%(refname:short)\x02%(creatordate:iso-strict)', 'refs/tags'])
	.split('\n').filter(Boolean).map((l) => l.split('\x02'));
const seen = new Set();
const releases = [];
for (const [tag, at] of tags) {
	const held = run(['rev-list', tag]).split('\n').filter((h) => h && !seen.has(h));
	for (const h of held) seen.add(h);
	const cs = held.map((h) => byFull.get(h)).filter((c) => c !== undefined);
	for (const c of cs) {
		c.tag = tag;
		c.released = at;
	}
	const fix = cs.filter((c) => c.type === 'fix').length, feat = cs.filter((c) => c.type === 'feat').length;
	releases.push({ tag, at, day: at.slice(0, 10), prerelease: tag.includes('-'), commits: cs.length, fix, feat, other: cs.length - fix - feat });
}
save('releases.json', releases);

const fixes = commits.filter((c) => c.type === 'fix');
save('fix_release.json', fixes.map((c) => ({
	hash: c.full.slice(0, 7), subject: c.subject, at: c.at, tag: c.tag ?? null,
	hours: c.tag && c.released ? hours(c.at, c.released) : null
})));

// --- fixes of fixes: blame the lines each fix changed --------------------------------
const followups = [];
for (const c of fixes.filter((c) => !c.merge)) {
	const code = c.files.filter((f) => f.startsWith('src/') && !isTest(f));
	/** @type {Set<string>} */
	const origins = new Set();
	for (const f of code) {
		let diff;
		try {
			diff = run(['diff', '-U0', c.full + '^', c.full, '--', f]);
		} catch {
			continue;
		}
		const ranges = [];
		for (const line of diff.split('\n')) {
			const m = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
			const n = m ? Number(m[2] ?? 1) : 0;
			if (m && n) ranges.push('-L', `${m[1]},${Number(m[1]) + n - 1}`);
		}
		if (!ranges.length) continue;
		let blame;
		try {
			blame = run(['blame', '--porcelain', ...ranges, c.full + '^', '--', f]);
		} catch {
			continue; // added in this fix
		}
		for (const line of blame.split('\n')) {
			const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
			if (m) origins.add(m[1]);
		}
	}
	const known = [...origins].map((h) => byFull.get(h)).filter((o) => o !== undefined);
	// The newest code the fix changed is what it repaired.
	const o = known.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
	followups.push({
		hash: c.full.slice(0, 7), subject: c.subject, at: c.at,
		origin: o ? o.full.slice(0, 7) : null,
		origin_type: o ? o.type : code.length ? 'Only added lines' : 'No source code changed',
		origin_subject: o?.subject ?? null,
		gap_hours: o ? hours(o.at, c.at) : null
	});
}
save('fix_origins.json', followups);

// --- areas and hotspots ----------------------------------------------------------------
/** @type {Map<string, { period: string, area: string, commits: number, lines: number }>} */
const areas = new Map();
const areaRow = (/** @type {string} */ period, /** @type {string} */ name) => {
	const key = period + '\0' + name;
	if (!areas.has(key)) areas.set(key, { period, area: name, commits: 0, lines: 0 });
	return /** @type {{ period: string, area: string, commits: number, lines: number }} */ (areas.get(key));
};
/** @type {Map<string, number>} */
const touched = new Map();
for (const c of commits.filter((c) => !c.merge)) {
	for (const name of new Set(c.files.map(area))) areaRow(c.period, name).commits++;
	for (const f of c.files) touched.set(c.period + '\0' + f, (touched.get(c.period + '\0' + f) ?? 0) + 1);
}
// Lines per file again, so each file's lines land in its own area.
for (const block of run(['log', '--no-merges', '--format=%x01%H', '--numstat', 'HEAD']).split('\x01').slice(1)) {
	const [h, ...body] = block.split('\n');
	for (const line of body.filter(Boolean)) {
		const [a, d, p] = line.split('\t');
		if (a === '-' || p.endsWith('package-lock.json') || p.includes('/fixtures/') || p.includes('/recordings/')) continue;
		areaRow(periodOf(h.trim()), area(renamed(p))).lines += Number(a) + Number(d);
	}
}
save('areas.json', [...areas.values()].sort((a, b) => (a.period + a.area < b.period + b.area ? -1 : 1)));

const hot = [];
for (const period of ['Up to 1.0.0', 'After 1.0.0']) {
	const top = [...touched].filter(([k]) => k.startsWith(period + '\0')).sort((a, b) => b[1] - a[1]).slice(0, 12);
	hot.push(...top.map(([k, n], i) => ({ period, file: k.split('\0')[1], commits: n, rank: i + 1 })));
}
save('hotspots.json', hot);

// --- lines per week, at each Sunday's last commit (and the last day) ---------------------
const DAY = 864e5;
const first = Date.parse(commits[0].day), last = Date.parse(commits[commits.length - 1].day);
const loc = [];
for (let d = first + ((7 - new Date(first).getUTCDay()) % 7) * DAY; ; d += 7 * DAY) {
	const end = new Date(Math.min(d, last)).toISOString().slice(0, 10);
	const rev = run(['rev-list', '-1', `--before=${end} 23:59:59`, 'HEAD']).trim();
	if (rev) {
		const n = { source: 0, tests: 0, docs: 0 };
		for (const line of run(['grep', '-c', '', rev, '--', 'src', 'tests', 'docs', '*.md']).split('\n').filter(Boolean)) {
			const rest = line.slice(line.indexOf(':') + 1);
			const p = rest.slice(0, rest.lastIndexOf(':')), count = Number(rest.slice(rest.lastIndexOf(':') + 1));
			if (p.endsWith('.json') || p.endsWith('.lock') || p.includes('/fixtures/') || p.includes('/recordings/')) continue;
			const kind = isTest(p) ? 'tests' : p.endsWith('.md') ? 'docs' : p.startsWith('src/') ? 'source' : null;
			if (kind) n[kind] += count;
		}
		loc.push({ week: end, ...n });
	}
	if (d >= last) break;
}
save('loc_weekly.json', loc);

// --- work sessions: a pause over two hours starts a new one ------------------------------
const sessions = [];
for (const c of commits) {
	const s = sessions[sessions.length - 1];
	if (s && Date.parse(c.at) - Date.parse(s.end) <= 2 * 36e5) {
		s.end = c.at;
		s.commits++;
	} else sessions.push({ start: c.at, end: c.at, commits: 1 });
}
save('sessions.json', sessions.map((s) => ({
	start: s.start, day: s.start.slice(0, 10), start_hour: Number(s.start.slice(11, 13)) + Number(s.start.slice(14, 16)) / 60,
	minutes: Math.round((Date.parse(s.end) - Date.parse(s.start)) / 6e4), commits: s.commits
})));

// --- GitHub Actions runs ----------------------------------------------------------------------
/** @type {{ databaseId: number, workflowName: string, conclusion: string, status: string, createdAt: string, updatedAt: string, headBranch: string, event: string }[]} */
const runs = JSON.parse(run(['run', 'list', '--limit', '1000', '--json',
	'databaseId,workflowName,conclusion,status,createdAt,updatedAt,headBranch,event'], 'gh'));
save('ci_runs.json', runs.filter((r) => r.status === 'completed').map((r) => ({
	id: String(r.databaseId), workflow: r.workflowName, conclusion: r.conclusion || r.status, at: r.createdAt,
	day: r.createdAt.slice(0, 10), minutes: Math.round((Date.parse(r.updatedAt) - Date.parse(r.createdAt)) / 6e3) / 10,
	branch: r.headBranch, event: r.event
})).sort((a, b) => (a.at < b.at ? -1 : 1)));
