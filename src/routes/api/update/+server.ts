import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { currentVersion, startedAt, updateRunState } from '#lib/server/selfupdate.js';

/**
 * Polled by Settings > Updates while an update runs or a database copy is put back: the running
 * version, when this process started, and how the update went.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	return json({ current: currentVersion(), started: startedAt, run: await updateRunState() });
};
