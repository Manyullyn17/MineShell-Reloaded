import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { AccountError, createAccount, grantsOf, listAccounts } from '#lib/server/accounts.js';
import { requireGlobalAdmin } from '#lib/server/access.js';
import { audit } from '#lib/server/instances.js';

/** MineShell settings > Accounts: everyone who can sign in, and adding someone. */
export const load: PageServerLoad = ({ locals }) => ({
	accounts: listAccounts().map((a) => ({ ...a, servers: Object.keys(grantsOf(a.id)).length })),
	/** Only the owner makes global admins. */
	owner: locals.access.owner
});

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requireGlobalAdmin(locals);
		const form = await request.formData();
		const globalAdmin = form.get('globalAdmin') === 'on';
		if (globalAdmin && !locals.access.owner) return fail(403, { ok: false, message: 'Only the owner makes MineShell admins.' });
		try {
			const { account, password } = createAccount(String(form.get('newAccount') ?? ''), {
				globalAdmin,
				canCreate: form.get('canCreate') === 'on'
			});
			audit('account.created', { detail: `${account.username} by ${locals.user?.username ?? 'MineShell'}` });
			// Shown once, here; only its hash is kept.
			return { ok: true, message: `Added ${account.username}.`, created: { id: account.id, username: account.username, password } };
		} catch (err) {
			if (err instanceof AccountError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
	}
};
