import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import yazl from 'yazl';
import { openZipFile } from './zip';
import type { ParsedPack } from './packs';
import { isLoaderInstallEntry } from './instances';

/**
 * Three-way merges of a pack's config files on a pack version change: the
 * pack's original of a file (the base, kept in `.mineshell/pack-base.zip`
 * since the install or last change), the user's copy (moved to old-configs/)
 * and the new pack's.
 *
 * - Not edited by the user: the new pack's file stands, as before.
 * - Edited, and the pack did not change it: the user's copy comes back.
 * - Both changed: merged line by line. Where both changed the same lines,
 *   the pack's lines win - so the server still starts - and the file is
 *   listed as needing a look.
 * - A file the user added (the pack never had it): carried back, unless the
 *   new pack now ships one at that path.
 * Everything is listed in a report the Modpack settings show, with what is
 * needed to compare and pick a side later. Old-configs/ keeps the user's
 * copies whatever happens.
 */

export const BASE_FILE = path.join('.mineshell', 'pack-base.zip');
export const REPORTS_DIR = path.join('.mineshell', 'config-merges');
/** Bigger files are recorded by hash only: enough to tell whether they were edited. */
const MAX_BASE_BYTES = 4 * 1024 * 1024;
const MANIFEST = 'manifest.json';

const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');

// ------------------------------------------------------------- the merge ---

/** Lines with their endings, so a merge gives back exactly what it was given. */
function lines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type Hunk = { start: number; end: number; lines: string[] };

/** Longer middles than this (lines x lines) are treated as one change rather than diffed. */
const MAX_CELLS = 4_000_000;

/**
 * Where `b` differs from `a`, as hunks over `a` (replace a[start..end) with
 * lines). Common prefix and suffix first, then a longest common subsequence
 * on what is left; a middle too big for that becomes one hunk, which can only
 * make a merge more careful (a conflict), never wrong.
 */
export function diffLines(a: string[], b: string[]): Hunk[] {
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const am = a.slice(pre, a.length - suf);
	const bm = b.slice(pre, b.length - suf);
	if (!am.length && !bm.length) return [];
	if (!am.length || !bm.length || (am.length + 1) * (bm.length + 1) > MAX_CELLS) {
		return [{ start: pre, end: pre + am.length, lines: bm }];
	}
	const n = am.length;
	const m = bm.length;
	const width = m + 1;
	const lcs = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * width + j] = am[i] === bm[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
		}
	}
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	let open: Hunk | null = null;
	const close = () => {
		if (open) hunks.push(open);
		open = null;
	};
	while (i < n || j < m) {
		if (i < n && j < m && am[i] === bm[j]) {
			close();
			i++;
			j++;
		} else if (j < m && (i === n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
			open ??= { start: pre + i, end: pre + i, lines: [] };
			open.lines.push(bm[j++]);
		} else {
			open ??= { start: pre + i, end: pre + i, lines: [] };
			open.end = pre + ++i;
		}
	}
	close();
	return hunks;
}

const overlaps = (x: Hunk, y: Hunk) =>
	x.start < y.end && y.start < x.end ? true : x.start === y.start || (x.start === x.end && x.start === y.end) || (y.start === y.end && y.start === x.end);

/**
 * Merges `mine` and `theirs`, both changed from `base`. Changes to different
 * lines are both kept; where both changed the same lines (and differently),
 * theirs is used and the region counts as a conflict.
 */
export function merge3(base: string, mine: string, theirs: string): { text: string; conflicts: number } {
	const o = lines(base);
	const tagged = [
		...diffLines(o, lines(mine)).map((h) => ({ ...h, side: 'mine' as const })),
		...diffLines(o, lines(theirs)).map((h) => ({ ...h, side: 'theirs' as const }))
	].sort((x, y) => x.start - y.start || x.end - y.end);

	const out: string[] = [];
	let conflicts = 0;
	let at = 0;
	for (let k = 0; k < tagged.length; ) {
		// A group: hunks that overlap one another, from either side.
		const group = [tagged[k++]];
		let end = group[0].end;
		while (k < tagged.length && group.some((h) => overlaps(h, tagged[k]))) {
			end = Math.max(end, tagged[k].end);
			group.push(tagged[k++]);
		}
		const start = group[0].start;
		out.push(...o.slice(at, start));
		const sides = new Set(group.map((h) => h.side));
		const region = (side: 'mine' | 'theirs') => {
			// The region [start, end) of base with one side's hunks applied.
			const result: string[] = [];
			let i = start;
			for (const h of group.filter((g) => g.side === side)) {
				result.push(...o.slice(i, h.start), ...h.lines);
				i = h.end;
			}
			result.push(...o.slice(i, end));
			return result;
		};
		if (sides.size === 1) out.push(...region(group[0].side));
		else {
			const ours = region('mine');
			const pack = region('theirs');
			if (ours.join('') !== pack.join('')) conflicts++;
			out.push(...pack);
		}
		at = end;
	}
	out.push(...o.slice(at));
	return { text: out.join(''), conflicts };
}

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

// ---------------------------------------------------------- pack originals ---

/** A pack version's own copies of the files it ships, by path in the server folder. */
export type Base = {
	/** Which pack version these are the originals of (baseTag). */
	tag?: string;
	hash: (rel: string) => string | undefined;
	read: (rel: string) => Promise<Buffer | null>;
};

/** Never moved to old-configs and never overwritten by a pack's overrides (packchange.ts). */
export const PROTECTED = new Set([
	'mods',
	'server.properties',
	'eula.txt',
	'ops.json',
	'whitelist.json',
	'banned-players.json',
	'banned-ips.json',
	'usercache.json',
	'logs',
	'crash-reports',
	'old-configs',
	'.mineshell'
]);

/**
 * The files a pack owns: what its overrides write outside mods/, protected
 * files, world folders (`worldTops`) and loader files - server-overrides
 * winning, as when installing.
 */
export function packFiles(pack: ParsedPack, worldTops: Set<string>): Map<string, Buffer> {
	const skip = (top: string) => PROTECTED.has(top) || worldTops.has(top) || isLoaderInstallEntry(top);
	const files = new Map<string, Buffer>();
	if (!pack.zip) return files;
	const ordered = [...pack.overrideEntries].sort(
		(a, b) => Number(a.startsWith('server-overrides/')) - Number(b.startsWith('server-overrides/'))
	);
	for (const entry of ordered) {
		const rel = entry.replace(/^(server-overrides|overrides)\//, '');
		const top = rel.split('/')[0];
		if (!rel || top === 'mods' || skip(top)) continue;
		const data = pack.zip.readFile(entry);
		if (data) files.set(rel, data);
	}
	return files;
}

/**
 * Names the pack version a server is on, as its row records it. A saved base
 * whose tag differs is another version's - a change that rolled back after
 * writing it, or one cut short before - and is not used.
 */
export function baseTag(instance: {
	packSource: string | null;
	packProjectId: string | null;
	packVersionId: string | null;
	packName: string | null;
	packVersionName: string | null;
}): string {
	return JSON.stringify([instance.packSource, instance.packProjectId, instance.packVersionId, instance.packName, instance.packVersionName]);
}

export function baseFromFiles(files: Map<string, Buffer>): Base {
	const hashes = new Map([...files].map(([rel, data]) => [rel, sha1(data)]));
	return { hash: (rel) => hashes.get(rel), read: async (rel) => files.get(rel) ?? null };
}

/** Saves a pack version's originals as the base for the next change. */
export async function writeBase(files: Map<string, Buffer>, dest: string, tag: string): Promise<void> {
	await fs.mkdir(path.dirname(dest), { recursive: true });
	const zip = new yazl.ZipFile();
	const hashes: Record<string, string> = {};
	for (const [rel, data] of files) {
		hashes[rel] = sha1(data);
		if (data.length <= MAX_BASE_BYTES) zip.addBuffer(data, `files/${rel}`);
	}
	zip.addBuffer(Buffer.from(JSON.stringify({ tag, files: hashes })), MANIFEST);
	zip.end();
	const tmp = `${dest}.part`;
	const out = (await fs.open(tmp, 'w')).createWriteStream();
	await new Promise<void>((resolve, reject) => {
		zip.outputStream.pipe(out).on('finish', () => resolve()).on('error', reject);
		zip.outputStream.on('error', reject);
	});
	await fs.rename(tmp, dest);
}

/** The base saved in the server folder; null when there is none (older installs, uploads before this existed). */
export async function readBase(root: string): Promise<Base | null> {
	const zip = await openZipFile(path.join(root, BASE_FILE)).catch(() => null);
	if (!zip) return null;
	const manifestEntry = zip.entries.find((e) => e.name === MANIFEST);
	if (!manifestEntry) return null;
	const { tag, files } = JSON.parse((await zip.read(manifestEntry)).toString('utf8')) as { tag?: string; files: Record<string, string> };
	const entries = new Map(zip.entries.filter((e) => e.name.startsWith('files/')).map((e) => [e.name.slice('files/'.length), e]));
	return {
		tag,
		hash: (rel) => files[rel],
		read: async (rel) => {
			const entry = entries.get(rel);
			return entry ? zip.read(entry) : null;
		}
	};
}

// ----------------------------------------------------------------- merging ---

export type MergeOutcome =
	/** Edited by the user, unchanged by the pack: the user's copy is back. */
	| 'kept'
	/** Both changed different lines: merged. */
	| 'merged'
	/** Both changed the same lines (or a file that cannot be merged): the pack's lines are in place. */
	| 'conflict'
	/** The user's own file, which the pack does not ship: back in place. */
	| 'carried'
	/** The user's own file, and the new pack now ships one at that path: the pack's is in place. */
	| 'both-added'
	/** Edited by the user, but the new pack no longer has it: left in old-configs. */
	| 'dropped';

export type MergeEntry = { path: string; outcome: MergeOutcome; resolved: 'mine' | 'pack' | null };

export type MergeReport = { stamp: string; oldConfigs: string; createdAt: number; entries: MergeEntry[] };

async function walk(dir: string, rel: string, out: string[]): Promise<void> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const child = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) await walk(path.join(dir, entry.name), child, out);
		else if (entry.isFile()) out.push(child);
	}
}

const readOrNull = (file: string) => fs.readFile(file).catch(() => null);

/**
 * Brings the user's config edits back into the freshly written pack files.
 * `oldConfigs` holds the user's copies (moved there whole) of `tops`; `root`
 * has the new pack's files. What a later review needs is written under
 * `reportDir`: the base and the pack's copy of every file that was merged or
 * left to the pack, and report.json.
 */
export async function mergeConfigs(
	root: string,
	oldConfigs: string,
	tops: string[],
	base: Base,
	reportDir: string,
	stamp: string
): Promise<MergeReport> {
	const report: MergeReport = { stamp, oldConfigs: path.relative(root, oldConfigs), createdAt: Date.now(), entries: [] };
	const keep = async (side: 'base' | 'theirs', rel: string, data: Buffer) => {
		const file = path.join(reportDir, side, rel);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, data);
	};
	const write = async (rel: string, data: Buffer | string) => {
		const file = path.join(root, rel);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, data);
	};

	const files: string[] = [];
	for (const top of tops) {
		const stat = await fs.stat(path.join(oldConfigs, top)).catch(() => null);
		if (stat?.isDirectory()) await walk(path.join(oldConfigs, top), top, files);
		else if (stat?.isFile()) files.push(top);
	}
	for (const rel of files.sort()) {
		const mine = await fs.readFile(path.join(oldConfigs, rel));
		const theirs = await readOrNull(path.join(root, rel));
		const baseHash = base.hash(rel);
		const add = (outcome: MergeOutcome) => report.entries.push({ path: rel, outcome, resolved: null });

		if (baseHash === undefined) {
			// Not the pack's: the user's own file.
			if (!theirs) {
				await write(rel, mine);
				add('carried');
			} else if (!theirs.equals(mine)) {
				await keep('theirs', rel, theirs);
				add('both-added');
			}
			continue;
		}
		if (sha1(mine) === baseHash) continue;
		if (!theirs) {
			add('dropped');
			continue;
		}
		if (theirs.equals(mine)) continue;
		if (sha1(theirs) === baseHash) {
			await keep('theirs', rel, theirs);
			await write(rel, mine);
			add('kept');
			continue;
		}
		const original = await base.read(rel);
		await keep('theirs', rel, theirs);
		if (!original || isBinary(original) || isBinary(mine) || isBinary(theirs)) {
			add('conflict');
			continue;
		}
		await keep('base', rel, original);
		const merged = merge3(original.toString('utf8'), mine.toString('utf8'), theirs.toString('utf8'));
		await write(rel, merged.text);
		add(merged.conflicts ? 'conflict' : 'merged');
	}
	await fs.mkdir(reportDir, { recursive: true });
	await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, '\t'));
	return report;
}

// ------------------------------------------------------------------ review ---

/** The newest merge report of a server, or null. */
export async function latestMergeReport(root: string): Promise<MergeReport | null> {
	const dir = path.join(root, REPORTS_DIR);
	const stamps = (await fs.readdir(dir).catch(() => [] as string[])).sort().reverse();
	for (const stamp of stamps) {
		const text = await fs.readFile(path.join(dir, stamp, 'report.json'), 'utf8').catch(() => null);
		if (text) return JSON.parse(text) as MergeReport;
	}
	return null;
}

async function readReport(root: string, stamp: string): Promise<MergeReport | null> {
	if (!/^[\w.-]+$/.test(stamp)) return null;
	const text = await fs.readFile(path.join(root, REPORTS_DIR, stamp, 'report.json'), 'utf8').catch(() => null);
	return text ? (JSON.parse(text) as MergeReport) : null;
}

export type MergeView = {
	path: string;
	outcome: MergeOutcome;
	resolved: 'mine' | 'pack' | null;
	/** Null where a side does not exist or is not text. */
	base: string | null;
	mine: string | null;
	pack: string | null;
	current: string | null;
};

const text = (b: Buffer | null) => (b && !isBinary(b) ? b.toString('utf8') : null);

/** Everything the review shows for one file of a report. */
export async function mergeView(root: string, stamp: string, rel: string): Promise<MergeView | null> {
	const report = await readReport(root, stamp);
	const entry = report?.entries.find((e) => e.path === rel);
	if (!report || !entry) return null;
	const dir = path.join(root, REPORTS_DIR, stamp);
	const mine = await readOrNull(path.join(root, report.oldConfigs, rel));
	return {
		path: rel,
		outcome: entry.outcome,
		resolved: entry.resolved,
		base: text(await readOrNull(path.join(dir, 'base', rel))),
		mine: text(mine),
		// The pack's copy; a carried or dropped file has none.
		pack: text(await readOrNull(path.join(dir, 'theirs', rel))),
		current: text(await readOrNull(path.join(root, rel)))
	};
}

/**
 * Puts one side of a reviewed file in place and records the choice. The
 * pack's side of a carried file (one the pack never had) is no file at all,
 * as is the pack's side of a dropped one.
 */
export async function resolveMerge(root: string, stamp: string, rel: string, use: 'mine' | 'pack'): Promise<boolean> {
	const report = await readReport(root, stamp);
	const entry = report?.entries.find((e) => e.path === rel);
	if (!report || !entry) return false;
	const target = path.join(root, rel);
	const noPackFile = entry.outcome === 'carried' || entry.outcome === 'dropped';
	if (use === 'pack' && noPackFile) await fs.rm(target, { force: true });
	else {
		const data = await readOrNull(use === 'mine' ? path.join(root, report.oldConfigs, rel) : path.join(root, REPORTS_DIR, stamp, 'theirs', rel));
		if (!data) return false;
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, data);
	}
	entry.resolved = use;
	await fs.writeFile(path.join(root, REPORTS_DIR, stamp, 'report.json'), JSON.stringify(report, null, '\t'));
	return true;
}

export type DiffLine = { kind: ' ' | '+' | '-' | '…'; text: string };

/** b against a, line by line, long unchanged stretches folded to a marker. */
export function lineDiff(a: string, b: string, context = 3): DiffLine[] {
	const al = lines(a);
	const bl = lines(b);
	const out: DiffLine[] = [];
	const same = (from: number, to: number, first: boolean, last: boolean) => {
		const run = al.slice(from, to);
		const head = first ? 0 : context;
		const tail = last ? 0 : context;
		if (run.length <= head + tail + 1) return out.push(...run.map((t) => ({ kind: ' ' as const, text: t })));
		out.push(...run.slice(0, head).map((t) => ({ kind: ' ' as const, text: t })));
		out.push({ kind: '…', text: `${run.length - head - tail} unchanged lines` });
		out.push(...run.slice(run.length - tail).map((t) => ({ kind: ' ' as const, text: t })));
	};
	let at = 0;
	const hunks = diffLines(al, bl);
	hunks.forEach((h, i) => {
		same(at, h.start, i === 0, false);
		out.push(...al.slice(h.start, h.end).map((t) => ({ kind: '-' as const, text: t })));
		out.push(...h.lines.map((t) => ({ kind: '+' as const, text: t })));
		at = h.end;
	});
	if (hunks.length) same(at, al.length, false, true);
	return out;
}
