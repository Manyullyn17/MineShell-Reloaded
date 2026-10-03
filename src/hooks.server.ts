import type { Handle } from '@sveltejs/kit';
import { boot } from '$lib/server/boot';
import { guard } from '$lib/server/guard';

boot();

/** Access control (cross-site requests, setup, login) lives in guard.ts. */
export const handle: Handle = async ({ event, resolve }) => {
	return guard(event) ?? resolve(event);
};
