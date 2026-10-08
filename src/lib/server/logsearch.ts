import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { ServerInstance } from './db/schema';
import { listRuns, searchJournal, searchRun } from './journal';
import { isLogPath, listLogFiles } from './logfiles';
import { stripAnsi } from '#lib/shared/consolelines.js';

/**
 * Search across a server's logs: every run the journal still holds and the
 * server's own log files (crash reports, latest.log, the rotated .log.gz).
 * The Logs tab shows one log at a time; this finds which ones mention
 * something, with a few of the lines.
 */

const gunzip = promisify(zlib.gunzip);

export type LogHit = {
	kind: 'run' | 'file';
	/** The run's invocation id, or the file's path (crash-reports/x.txt). */
	key: string;
	/** When the run started, or the file was last written. */
	at: number;
	/** The first matching lines. */
	lines: string[];
	/** How many lines match in all (journal: of the newest JOURNAL_LIMIT matches). */
	count: number;
};

export const SHOWN_PER_LOG = 4;
/** Newest matching journal lines read; enough to say which runs mention it. */
const JOURNAL_LIMIT = 5000;
/** Files bigger than this (unpacked) are searched in their first part only. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Stop reading files after this long; what was found so far is returned. */
const FILE_BUDGET_MS = 8000;

export type LogSearch = { query: string; runs: LogHit[]; files: LogHit[]; partial: boolean };

export async function searchLogs(instance: ServerInstance, query: string): Promise<LogSearch> {
	const q = query.trim();
	if (q.length < 2) return { query: q, runs: [], files: [], partial: false };
	const [runs, files] = await Promise.all([searchRuns(instance, q), searchFiles(instance.path, q)]);
	return { query: q, runs, files: files.hits, partial: files.partial };
}

async function searchRuns(instance: ServerInstance, q: string): Promise<LogHit[]> {
	const [events, runs] = await Promise.all([searchJournal(instance.id, q, instance.createdAt, JOURNAL_LIMIT), listRuns(instance.id, instance.createdAt)]);
	const started = new Map(runs.map((r) => [r.invocation, r.startedAt]));
	const hits = new Map<string, LogHit>();
	for (const event of events) {
		if (!event.invocation) continue;
		let hit = hits.get(event.invocation);
		if (!hit) {
			hit = { kind: 'run', key: event.invocation, at: started.get(event.invocation) ?? event.at, lines: [], count: 0 };
			hits.set(event.invocation, hit);
		}
		hit.count++;
		if (hit.lines.length < SHOWN_PER_LOG) hit.lines.push(stripAnsi(event.message));
	}
	return [...hits.values()].sort((a, b) => b.at - a.at);
}

async function searchFiles(root: string, q: string): Promise<{ hits: LogHit[]; partial: boolean }> {
	const needle = q.toLowerCase();
	const hits: LogHit[] = [];
	const until = Date.now() + FILE_BUDGET_MS;
	for (const file of await listLogFiles(root)) {
		if (Date.now() > until) return { hits, partial: true };
		const text = await readWhole(path.join(root, file.path));
		if (text === null) continue;
		let count = 0;
		const lines: string[] = [];
		for (const line of text.split('\n')) {
			if (!line.toLowerCase().includes(needle)) continue;
			count++;
			if (lines.length < SHOWN_PER_LOG) lines.push(stripAnsi(line.trimEnd()));
		}
		if (count) hits.push({ kind: 'file', key: file.path, at: file.modifiedAt, lines, count });
	}
	return { hits, partial: false };
}

async function readWhole(file: string): Promise<string | null> {
	try {
		if (file.endsWith('.gz')) return (await gunzip(await fs.readFile(file), { maxOutputLength: MAX_FILE_BYTES })).toString('utf8');
		const handle = await fs.open(file, 'r');
		try {
			const { size } = await handle.stat();
			const bytes = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
			await handle.read(bytes, 0, bytes.length, 0);
			return bytes.toString('utf8');
		} finally {
			await handle.close();
		}
	} catch {
		// Damaged, or unpacks to more than the limit (gunzip refuses the whole thing).
		return null;
	}
}

/** Matching lines of one log, from all of it: the Logs tab shows only a long log's end. */
export type LogMatch = { line: number | null; text: string };
const MATCHES_IN_LOG = 5000;

export async function matchesIn(instance: ServerInstance, kind: 'run' | 'file', key: string, query: string): Promise<LogMatch[]> {
	const q = query.trim();
	if (q.length < 2) return [];
	if (kind === 'run') return (await searchRun(key, q, instance.createdAt, MATCHES_IN_LOG)).map((text) => ({ line: null, text: stripAnsi(text) }));
	if (!isLogPath(key)) return [];
	const text = await readWhole(path.join(instance.path, key));
	if (text === null) return [];
	const needle = q.toLowerCase();
	const out: LogMatch[] = [];
	text.split('\n').forEach((line, i) => {
		if (out.length < MATCHES_IN_LOG && line.toLowerCase().includes(needle)) out.push({ line: i + 1, text: stripAnsi(line.trimEnd()) });
	});
	return out;
}
