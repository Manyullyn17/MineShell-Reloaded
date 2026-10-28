import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import { deleteOldLogs, diskBreakdown } from '#lib/server/diskusage.js';
import { formatBytes } from '#lib/shared/format.js';
import { logKeepDays } from '#lib/server/logretention.js';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	// Streamed: walking a big pack's world takes a moment.
	return { breakdown: diskBreakdown(instance), logKeepDays: logKeepDays() };
};

export const actions: Actions = {
	deleteOldLogs: async ({ params }) => {
		const { files, bytes } = await deleteOldLogs(requireInstance(params.id).path);
		return { ok: true, message: files ? `Deleted ${files} old file${files === 1 ? '' : 's'}, ${formatBytes(bytes)}.` : 'Nothing old enough to delete.' };
	}
};
