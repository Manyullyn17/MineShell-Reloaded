import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	OWNER_USERNAME,
	SESSION_COOKIE,
	authEnabled,
	createOwner,
	createSession,
	ownerExists,
	sessionCookieOptions
} from '#lib/server/auth.js';
import { DATA_DIR } from '#lib/server/config.js';
import { probeSystemd, templateUnitInstalled } from '#lib/server/systemd.js';

export const load: PageServerLoad = async () => {
	if (ownerExists() || !authEnabled()) redirect(303, '/');
	const systemd = await probeSystemd();
	return {
		dataDir: DATA_DIR,
		username: OWNER_USERNAME,
		systemd,
		unitInstalled: await templateUnitInstalled()
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		if (ownerExists()) redirect(303, '/login');

		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');

		if (password !== confirm) return fail(400, { message: 'The two passwords do not match.' });

		let owner;
		try {
			owner = createOwner(password);
		} catch (err) {
			return fail(400, { message: err instanceof Error ? err.message : 'Could not set the password.' });
		}

		const session = createSession(owner.id, request.headers.get('user-agent'));
		cookies.set(SESSION_COOKIE, session.id, sessionCookieOptions(request, url));
		redirect(303, '/');
	}
};
