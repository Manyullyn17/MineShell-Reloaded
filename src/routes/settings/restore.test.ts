import { describe, expect, it, vi } from 'vitest';

// Its own task list: in a shared worker, other files' running tasks would block the restore.
vi.mock('#lib/server/tasks.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('#lib/server/tasks.js')>()), listTasks: () => [] }));
import { actions } from './+page.server';
import { GET } from '../api/update/+server';
import { cancelPendingRestore } from '#lib/server/dbrestore.js';
import { dailyDatabaseCopy } from '#lib/server/dbbackups.js';
import { call, post } from '../../../tests/helpers/routes';

/**
 * Putting a database copy back restarts MineShell under the page: it said nothing until then.
 * The page waits for /api/update to answer from a process that started after the one that took
 * the request, so both must report the same start time for the same process.
 */
describe('putting a database copy back', () => {
	it('answers with when this MineShell started, which /api/update reports until it restarts', async () => {
		await dailyDatabaseCopy(new Date(2026, 9, 5, 12).getTime());
		const answer = (await post(actions.restoreDatabase, { fields: { file: 'daily-2026-10-05.db', understood: 'on' } })) as Record<string, unknown>;
		await cancelPendingRestore();
		// Tests run from a checkout: nothing restarts, so the page shows the message instead of waiting.
		expect(answer).toMatchObject({ ok: true, restarting: false });
		const state = (await (await call(GET)).json()) as { started: number };
		expect(typeof answer.startedAt).toBe('number');
		expect(state.started).toBe(answer.startedAt);
	});
});
