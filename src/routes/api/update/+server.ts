import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { currentVersion, updateRunState } from '#lib/server/selfupdate.js';

/** Polled by Settings > Updates while an update runs: the running version, and how the update went. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	return json({ current: currentVersion(), run: await updateRunState() });
};
