import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	SESSION_COOKIE,
	authEnabled,
	createSession,
	passwordIsSet,
	sessionCookieOptions,
	setPassword
} from '#lib/server/auth.js';
import { DATA_DIR } from '#lib/server/config.js';
import { probeSystemd, templateUnitInstalled } from '#lib/server/systemd.js';

export const load: PageServerLoad = async () => {
	if (passwordIsSet() || !authEnabled()) redirect(303, '/');
	const systemd = await probeSystemd();
	return {
		dataDir: DATA_DIR,
		systemd,
		unitInstalled: await templateUnitInstalled()
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		if (passwordIsSet()) redirect(303, '/login');

		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');

		if (password !== confirm) return fail(400, { message: 'The two passwords do not match.' });

		try {
			setPassword(password);
		} catch (err) {
			return fail(400, { message: err instanceof Error ? err.message : 'Could not set the password.' });
		}

		const session = createSession(request.headers.get('user-agent'));
		cookies.set(SESSION_COOKIE, session.id, sessionCookieOptions(request, url));
		redirect(303, '/');
	}
};
