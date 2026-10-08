import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { logShares, type ServerInstance } from './db/schema';
import { stripAnsi } from '#lib/shared/consolelines.js';

/**
 * mclo.gs (Aternos) as a second opinion on a log, only when asked:
 * - analyse: `POST /1/analyse` reads the log and returns its problems with
 *   solutions, without keeping it.
 * - share: `POST /1/log` keeps it at a public link for 90 days (mclo.gs masks
 *   IP addresses, home folders and tokens first); the token it returns is
 *   kept so the share can be deleted again.
 * Useful most where crashdiag.ts recognises nothing.
 */

const API = 'https://api.mclo.gs/1';
/** mclo.gs's limits (GET /1/limits): 10 MiB and 25,000 lines. A crash is at the end, so the end is kept. */
const MAX_LINES = 25_000;
const MAX_BYTES = 10 * 1024 * 1024;

export type McLogsAnalysis = {
	/** What mclo.gs took the log for, e.g. "Fabric 1.20.1 Server Log". */
	title: string | null;
	problems: { message: string; solutions: string[]; line: number | null }[];
	information: { label: string; value: string }[];
};

export class McLogsError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null
	) {
		super(message);
	}
}

/** The log as sent: colours stripped, the end within the limits. */
export function prepareLog(text: string): string {
	let lines = stripAnsi(text).split('\n');
	if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
	let out = lines.join('\n');
	while (Buffer.byteLength(out) > MAX_BYTES) {
		lines = lines.slice(Math.ceil(lines.length / 10));
		out = lines.join('\n');
	}
	return out;
}

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Record<string, unknown>> {
	let res: Response;
	try {
		res = await fetch(`${API}${path}`, {
			method,
			headers: {
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000)
		});
	} catch {
		throw new McLogsError('mclo.gs could not be reached.');
	}
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !data?.success) {
		throw new McLogsError(typeof data?.error === 'string' ? `mclo.gs: ${data.error}` : `mclo.gs answered ${res.status}.`, res.status);
	}
	return data;
}

type RawEntry = { message?: unknown; solutions?: { message?: unknown }[]; entry?: { lines?: { number?: unknown }[] }; label?: unknown; value?: unknown };

export async function analyseLog(text: string): Promise<McLogsAnalysis> {
	const data = await call('POST', '/analyse', { content: prepareLog(text) });
	const analysis = (data.analysis ?? {}) as { problems?: RawEntry[]; information?: RawEntry[] };
	return {
		title: typeof data.title === 'string' ? data.title : null,
		problems: (analysis.problems ?? []).map((p) => ({
			message: String(p.message ?? ''),
			solutions: (p.solutions ?? []).map((s) => String(s.message ?? '')).filter(Boolean),
			line: typeof p.entry?.lines?.[0]?.number === 'number' ? p.entry.lines[0].number : null
		})),
		information: (analysis.information ?? [])
			.filter((i) => typeof i.label === 'string')
			.map((i) => ({ label: String(i.label), value: String(i.value ?? '') }))
	};
}

export type LogShare = { url: string; createdAt: number; expiresAt: number | null };

export function shareOf(instanceId: string, kind: 'run' | 'file', key: string): LogShare | null {
	const row = db
		.select()
		.from(logShares)
		.where(and(eq(logShares.instanceId, instanceId), eq(logShares.kind, kind), eq(logShares.logKey, key)))
		.get();
	if (!row || (row.expiresAt && row.expiresAt < Date.now())) return null;
	return { url: row.url, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

/** Uploads the log (once: a log already shared keeps its link) and keeps the delete token. */
export async function shareLog(instance: ServerInstance, kind: 'run' | 'file', key: string, text: string): Promise<LogShare> {
	const existing = shareOf(instance.id, kind, key);
	if (existing) return existing;
	const data = await call('POST', '/log', { content: prepareLog(text), source: 'MineShell' });
	if (typeof data.id !== 'string' || typeof data.url !== 'string' || typeof data.token !== 'string') {
		throw new McLogsError('mclo.gs gave no link for the log.');
	}
	const share = {
		url: data.url,
		createdAt: typeof data.created === 'number' ? data.created * 1000 : Date.now(),
		expiresAt: typeof data.expires === 'number' ? data.expires * 1000 : null
	};
	db.delete(logShares)
		.where(and(eq(logShares.instanceId, instance.id), eq(logShares.kind, kind), eq(logShares.logKey, key)))
		.run();
	db.insert(logShares).values({ instanceId: instance.id, kind, logKey: key, pasteId: data.id, token: data.token, ...share }).run();
	return share;
}

/** Deletes the shared copy on mclo.gs, then forgets it. One already gone there is just forgotten. */
export async function unshareLog(instanceId: string, kind: 'run' | 'file', key: string): Promise<void> {
	const where = and(eq(logShares.instanceId, instanceId), eq(logShares.kind, kind), eq(logShares.logKey, key));
	const row = db.select().from(logShares).where(where).get();
	if (!row) return;
	try {
		await call('DELETE', `/log/${encodeURIComponent(row.pasteId)}`, undefined, row.token);
	} catch (err) {
		// Expired, or deleted on mclo.gs itself: nothing left to delete.
		const gone = (err instanceof McLogsError && err.status === 404) || (row.expiresAt && row.expiresAt < Date.now());
		if (!gone) throw err;
	}
	db.delete(logShares).where(where).run();
}
