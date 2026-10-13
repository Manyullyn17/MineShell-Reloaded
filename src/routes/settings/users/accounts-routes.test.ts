import { isHttpError, isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import * as list from './+page.server';
import * as detail from './[userId]/+page.server';
import * as accountPage from '../../account/+page.server';
import { createAccount, getAccount } from '#lib/server/accounts.js';
import { createSession, verifyLogin } from '#lib/server/auth.js';
import { FULL_ACCESS, NO_ACCESS, type Access } from '#lib/shared/access.js';
import { owner } from '../../../../tests/helpers/auth';

/** The Accounts pages' actions, as the owner, a global admin, and an account itself. */

const globalAdmin: Access = { ...NO_ACCESS, globalAdmin: true, canCreate: true };
let n = 0;
const name = () => `route${process.pid}x${++n}`;

async function post(action: unknown, event: { params?: Record<string, string>; access: Access; user?: unknown; fields?: Record<string, string>; cookie?: string }) {
	const form = new FormData();
	for (const [key, value] of Object.entries(event.fields ?? {})) form.set(key, value);
	try {
		return await (action as (e: never) => unknown)({
			params: event.params ?? {},
			request: new Request('http://localhost/', { method: 'POST', body: form }),
			locals: { access: event.access, user: event.user ?? null },
			cookies: { get: () => event.cookie }
		} as never);
	} catch (err) {
		if (isHttpError(err)) return { refused: err.status };
		if (isRedirect(err)) return { redirect: err.location };
		throw err;
	}
}

describe('Accounts', () => {
	it('a global admin adds accounts, but only the owner adds MineShell admins', async () => {
		const made = (await post(list.actions.create, { access: globalAdmin, fields: { username: name(), canCreate: 'on' } })) as { created: { password: string; username: string } };
		expect(verifyLogin(made.created.username, made.created.password)).toMatchObject({ mustChangePassword: true });
		expect(await post(list.actions.create, { access: globalAdmin, fields: { username: name(), globalAdmin: 'on' } })).toMatchObject({ status: 403 });
		expect(await post(list.actions.create, { access: FULL_ACCESS, fields: { username: name(), globalAdmin: 'on' } })).toMatchObject({ ok: true });
	});

	it('nobody changes the owner here; only the owner changes or makes a global admin', async () => {
		const ownerId = owner().id;
		for (const action of ['disable', 'resetPassword', 'signOut', 'flags'] as const) {
			expect(await post(detail.actions[action], { params: { userId: ownerId }, access: FULL_ACCESS })).toEqual({ refused: 403 });
		}
		const peer = createAccount(name(), { globalAdmin: true, canCreate: true }).account;
		expect(await post(detail.actions.disable, { params: { userId: peer.id }, access: globalAdmin })).toEqual({ refused: 403 });
		expect(await post(detail.actions.disable, { params: { userId: peer.id }, access: FULL_ACCESS })).toMatchObject({ ok: true });

		const someone = createAccount(name(), { globalAdmin: false, canCreate: false }).account;
		expect(await post(detail.actions.flags, { params: { userId: someone.id }, access: globalAdmin, fields: { globalAdmin: 'on' } })).toMatchObject({ status: 403 });
		expect(await post(detail.actions.flags, { params: { userId: someone.id }, access: globalAdmin, fields: { canCreate: 'on' } })).toMatchObject({ ok: true });
		expect(getAccount(someone.id)).toMatchObject({ canCreate: true, isGlobalAdmin: false });
		// Taking global admin away is the owner's too.
		expect(await post(detail.actions.flags, { params: { userId: peer.id }, access: FULL_ACCESS, fields: {} })).toMatchObject({ ok: true });
		expect(getAccount(peer.id)).toMatchObject({ isGlobalAdmin: false });
	});

	it('a reset shows a new one-time password once; delete wants the name typed', async () => {
		const someone = createAccount(name(), { globalAdmin: false, canCreate: false }).account;
		const reset = (await post(detail.actions.resetPassword, { params: { userId: someone.id }, access: globalAdmin })) as { reset: { password: string } };
		expect(verifyLogin(someone.username, reset.reset.password)).not.toBeNull();
		expect(await post(detail.actions.delete, { params: { userId: someone.id }, access: globalAdmin, fields: { confirm: 'nope' } })).toMatchObject({ status: 400 });
		expect(await post(detail.actions.delete, { params: { userId: someone.id }, access: globalAdmin, fields: { confirm: someone.username } })).toEqual({ redirect: '/settings/users' });
		expect(getAccount(someone.id)).toBeNull();
	});
});

describe('your account page', () => {
	it('changes the password only with the current one, and a forced change goes on to MineShell', async () => {
		const { account, password } = createAccount(name(), { globalAdmin: false, canCreate: false });
		const user = { id: account.id, username: account.username, isOwner: false, mustChangePassword: true };
		const cookie = createSession(account.id, null).id;
		const change = (fields: Record<string, string>) => post(accountPage.actions.password, { access: NO_ACCESS, user, fields, cookie });
		expect(await change({ current: 'wrong-one', password: 'my-own-password', confirm: 'my-own-password' })).toMatchObject({ status: 400 });
		expect(await change({ current: password, password: password, confirm: password })).toMatchObject({ status: 400 });
		expect(await change({ current: password, password: 'my-own-password', confirm: 'my-own-password' })).toEqual({ redirect: '/' });
		expect(verifyLogin(account.username, 'my-own-password')).toMatchObject({ mustChangePassword: false });
	});
});
