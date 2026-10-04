import type { PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import { listRuns, readRun } from '#lib/server/journal.js';
import { listLogFiles, readLogFile } from '#lib/server/logfiles.js';
import { diagnoseRun, type Diagnosis } from '#lib/server/crashdiag.js';
import { modsDir } from '#lib/server/mods/index.js';

/**
 * Earlier runs (from the journal, as long as it keeps them) and the server's
 * own crash reports and log files, with a crash diagnosis for a run that
 * ended badly or a crash report. The overview only looks at the last run.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const instance = requireInstance(params.id);
	const [runs, files] = await Promise.all([listRuns(instance.id, instance.createdAt), listLogFiles(instance.path)]);

	const runId = url.searchParams.get('run');
	const filePath = url.searchParams.get('file');
	let view: { kind: 'run' | 'file'; key: string; text: string; truncated: boolean; failed: boolean } | null = null;

	if (runId) {
		const run = runs.find((r) => r.invocation === runId);
		if (run) {
			const text = await readRun(run.invocation, instance.createdAt);
			const started = /\]: Done \(/.test(text);
			// 143 is Java answering SIGTERM: a stop, not a crash.
			const failed = (!!run.failure && !/status=143\b/.test(run.exit ?? '')) || (run.endedAt !== null && !started);
			view = { kind: 'run', key: run.invocation, text, truncated: text.split('\n').length >= 20000, failed };
		}
	} else if (filePath) {
		const read = await readLogFile(instance.path, filePath);
		if (read) view = { kind: 'file', key: filePath, ...read, failed: filePath.startsWith('crash-reports/') };
	}

	return {
		runs,
		files,
		view,
		// Streamed: indexing a big pack's mods takes a moment. Against the mods
		// installed now, which may have changed since that run.
		diagnosis: view?.failed ? diagnoseRun(view.text, modsDir(instance.path)).catch(() => [] as Diagnosis[]) : null
	};
};
