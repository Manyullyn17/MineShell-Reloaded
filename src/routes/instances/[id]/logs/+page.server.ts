import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import { listRuns, readRun, type RunSummary } from '#lib/server/journal.js';
import { bisectRuns, crashCausesByRun, startTimesByRun } from '#lib/server/history.js';
import { listLogFiles, readLogFile } from '#lib/server/logfiles.js';
import { diagnoseRun, type Diagnosis } from '#lib/server/crashdiag.js';
import { modsDir } from '#lib/server/mods/index.js';
import { matchesIn, searchLogs } from '#lib/server/logsearch.js';
import { analyseLog, shareLog, shareOf, unshareLog, type LogShare } from '#lib/server/mclogs.js';
import type { ServerInstance } from '#lib/server/db/schema.js';

/**
 * Earlier runs (from the journal, as long as it keeps them) and the server's
 * own crash reports and log files, with a crash diagnosis for a run that
 * ended badly or a crash report. The overview only looks at the last run.
 *
 * The journal reads take seconds on a big pack the first time (journal.ts
 * keeps them after that), so the runs and the open log are streamed: the
 * page opens at once with placeholders.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const instance = requireInstance(params.id);
	const runs = listRuns(instance.id, instance.createdAt);
	const files = await listLogFiles(instance.path);

	const filePath = url.searchParams.get('file');
	const query = url.searchParams.get('q')?.trim() ?? '';
	const view = openLog(instance, runs, url.searchParams.get('run'), filePath, query);

	return {
		runs,
		/** How long each run took to reach "Done (", by invocation (history.ts). */
		startTimes: startTimesByRun(instance.id),
		/** The crash analyzer's verdict for crashed runs, by invocation (history.ts). */
		crashCauses: crashCausesByRun(instance.id),
		/** The mod bisect assistant's test runs, labelled as such. */
		bisectRuns: bisectRuns(instance.id),
		files,
		view,
		query,
		// Streamed: the journal and every log file are read.
		search: query ? searchLogs(instance, query) : null,
		// The open log's matching lines from all of it, not just the end shown.
		inLog: view.then((v) => (query && v ? matchesIn(instance, v.kind, v.key, query).catch(() => []) : null)),
		// Indexing a big pack's mods takes a moment. Against the mods installed
		// now, which may have changed since that run.
		diagnosis: view.then((v) => (v?.failed ? diagnoseRun(v.text, modsDir(instance.path)).catch(() => [] as Diagnosis[]) : null))
	};
};

type OpenLog = {
	kind: 'run' | 'file';
	key: string;
	text: string;
	truncated: boolean;
	failed: boolean;
	/** The run shown, for its heading. */
	run: RunSummary | null;
	/** The log's link on mclo.gs, if it was shared. */
	share: LogShare | null;
};

/** The log the page shows: the one picked, or with nothing picked the newest run (a search shows its results first). */
async function openLog(
	instance: ServerInstance,
	runs: Promise<RunSummary[]>,
	runParam: string | null,
	filePath: string | null,
	query: string
): Promise<OpenLog | null> {
	let view: Omit<OpenLog, 'share'> | null = null;
	if (runParam || !(filePath || query)) {
		const list = await runs;
		const run = list.find((r) => r.invocation === (runParam ?? list[0]?.invocation));
		if (run) {
			// One run reads by invocation id, which is quick.
			const text = await readRun(run.invocation, instance.createdAt);
			const started = /\]: Done \(/.test(text);
			// 143 is Java answering SIGTERM: a stop, not a crash.
			const failed = (!!run.failure && !/status=143\b/.test(run.exit ?? '')) || (run.endedAt !== null && !started);
			view = { kind: 'run', key: run.invocation, text, truncated: text.split('\n').length >= 20000, failed, run };
		}
	} else if (filePath) {
		const read = await readLogFile(instance.path, filePath);
		if (read) view = { kind: 'file', key: filePath, ...read, failed: filePath.startsWith('crash-reports/'), run: null };
	}
	return view && { ...view, share: shareOf(instance.id, view.kind, view.key) };
}

/** The log a form names, as the page shows it: a run's newest lines, a file's end. */
async function logText(instance: ServerInstance, form: FormData): Promise<{ kind: 'run' | 'file'; key: string; text: string } | null> {
	const kind = form.get('kind') === 'file' ? 'file' : 'run';
	const key = String(form.get('key') ?? '');
	if (kind === 'run') {
		const runs = await listRuns(instance.id, instance.createdAt);
		if (!runs.some((r) => r.invocation === key)) return null;
		return { kind, key, text: await readRun(key, instance.createdAt) };
	}
	const read = await readLogFile(instance.path, key);
	return read ? { kind, key, text: read.text } : null;
}

export const actions: Actions = {
	/** A second opinion: mclo.gs reads the log and forgets it. */
	mclogsAnalyse: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const log = await logText(instance, await request.formData());
		if (!log?.text.trim()) return fail(404, { ok: false, message: 'That log is gone or empty.' });
		try {
			return { ok: true, mclogs: { key: log.key, ...(await analyseLog(log.text)) } };
		} catch (err) {
			return fail(502, { ok: false, message: err instanceof Error ? err.message : 'mclo.gs could not read it.' });
		}
	},

	/** A public link for 90 days, deletable from here. */
	mclogsShare: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const log = await logText(instance, await request.formData());
		if (!log?.text.trim()) return fail(404, { ok: false, message: 'That log is gone or empty.' });
		try {
			const share = await shareLog(instance, log.kind, log.key, log.text);
			return { ok: true, message: `Shared at ${share.url}.` };
		} catch (err) {
			return fail(502, { ok: false, message: err instanceof Error ? err.message : 'mclo.gs could not keep it.' });
		}
	},

	mclogsUnshare: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await unshareLog(instance.id, form.get('kind') === 'file' ? 'file' : 'run', String(form.get('key') ?? ''));
			return { ok: true, message: 'Deleted from mclo.gs.' };
		} catch (err) {
			return fail(502, { ok: false, message: err instanceof Error ? err.message : 'mclo.gs could not delete it.' });
		}
	}
};
