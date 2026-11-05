import type { RequestHandler } from './$types';
import { sees } from '#lib/server/access.js';
import { summariseAll } from '#lib/server/instances.js';
import { railInstances } from '#lib/server/rail.js';

/** The sidebar's servers, for the sidebar alone to stay current without reloading the page's data. */
export const GET: RequestHandler = async ({ locals }) => {
	return Response.json({ instances: await railInstances(await summariseAll(sees(locals.access))) });
};
