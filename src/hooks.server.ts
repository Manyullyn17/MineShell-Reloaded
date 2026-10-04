import type { Handle } from '@sveltejs/kit/hooks';
import { boot } from '#lib/server/boot.js';
import { guard } from '#lib/server/guard.js';

boot();

/** Access control (cross-site requests, setup, login) lives in guard.ts. */
export const handle: Handle = async ({ event, resolve }) => {
	return guard(event) ?? resolve(event);
};
