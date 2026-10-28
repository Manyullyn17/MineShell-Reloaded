import type { Handle } from '@sveltejs/kit/hooks';
import { boot } from '#lib/server/boot.js';
import { guard, withSecurityHeaders } from '#lib/server/guard.js';
import { runAs } from '#lib/server/requestcontext.js';
import { useUndiciFetch } from '#lib/server/undicifetch.js';

useUndiciFetch();
boot();

/**
 * Access control (cross-site requests, setup, login) lives in guard.ts. The
 * rest runs as the signed-in account, so the audit log says who did it.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const refused = guard(event);
	if (refused) return withSecurityHeaders(refused);
	const user = event.locals.user;
	return withSecurityHeaders(await runAs(user ? { id: user.id, username: user.username } : null, () => resolve(event)));
};
