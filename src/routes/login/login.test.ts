import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { SESSION_COOKIE, createSession, sessionUser } from '#lib/server/auth.js';
import { OWNER_PASSWORD, owner } from '../../../tests/helpers/auth';
import { cookieJar, post } from '../../../tests/helpers/routes';

/**
 * Signing in: the pieces (verifyLogin, the throttle, sameOriginPath) are
 * tested in auth.test.ts and links.test.ts; these check the action uses them.
 */

// The throttle is kept in memory for the whole run: each test signs in from an address of its own.
const address = () => `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;

const signIn = (fields: Record<string, string>, ip: string, cookies = cookieJar()) =>
	post(actions.login, { fields, ip, cookies, url: 'http://localhost/login' });

describe('signing in', () => {
	it('starts a session for the account and goes back where it was', async () => {
		const me = owner();
		const cookies = cookieJar();
		const result = await signIn({ username: 'ADMIN', password: OWNER_PASSWORD, next: '/instances/abc?tab=mods' }, address(), cookies);
		expect(result).toEqual({ redirect: '/instances/abc?tab=mods' });
		expect(sessionUser(cookies.values.get(SESSION_COOKIE))).toMatchObject({ id: me.id });
	});

	it('only ever goes back into MineShell', async () => {
		owner();
		for (const next of ['//evil.example/login', 'https://evil.example/', '/\\evil.example']) {
			const result = (await signIn({ username: 'admin', password: OWNER_PASSWORD, next }, address())) as { redirect: string };
			expect(new URL(result.redirect, 'http://localhost').origin).toBe('http://localhost');
		}
	});

	it('starts no session for a wrong password', async () => {
		owner();
		const cookies = cookieJar();
		const result = await signIn({ username: 'admin', password: 'wrong' }, address(), cookies);
		expect(result).toMatchObject({ status: 401, data: { username: 'admin' } });
		expect(cookies.values.size).toBe(0);
	});

	it('stops an address after ten wrong passwords, even with the right one; a sign-in in between starts the count again', async () => {
		owner();
		const ip = address();
		for (let i = 0; i < 9; i++) expect(await signIn({ username: 'admin', password: 'wrong' }, ip)).toMatchObject({ status: 401 });
		expect(await signIn({ username: 'admin', password: OWNER_PASSWORD }, ip)).toEqual({ redirect: '/' });
		for (let i = 0; i < 10; i++) expect(await signIn({ username: 'admin', password: 'wrong' }, ip)).toMatchObject({ status: 401 });

		const cookies = cookieJar();
		expect(await signIn({ username: 'admin', password: OWNER_PASSWORD }, ip, cookies)).toMatchObject({ status: 429 });
		expect(cookies.values.size).toBe(0);
		// Another address is not held up by it.
		expect(await signIn({ username: 'admin', password: OWNER_PASSWORD }, address())).toEqual({ redirect: '/' });
	});
});

describe('signing out', () => {
	it('ends the session and drops its cookie', async () => {
		const me = owner();
		const session = createSession(me.id, null).id;
		const cookies = cookieJar({ [SESSION_COOKIE]: session });
		expect(await post(actions.logout, { cookies })).toEqual({ redirect: '/login' });
		expect(sessionUser(session)).toBeNull();
		expect(cookies.values.has(SESSION_COOKIE)).toBe(false);
	});
});
