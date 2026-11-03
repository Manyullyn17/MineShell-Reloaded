import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as page from './+page.server';
import { actions } from './+page.server';
import { SESSION_COOKIE, createSession, sessionUser, setPlainHttpWarning } from '#lib/server/auth.js';
import { OWNER_PASSWORD, owner } from '../../../tests/helpers/auth';
import { cookieJar, load, post } from '../../../tests/helpers/routes';

/**
 * Signing in: the pieces (verifyLogin, the throttle, sameOriginPath) are
 * tested in auth.test.ts and links.test.ts; these check the action uses them.
 */

// The throttle is kept in memory for the whole run: each test signs in from an address of its own.
const address = () => `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;

const signIn = (fields: Record<string, string>, ip: string | Error, cookies = cookieJar(), headers?: Record<string, string>) =>
	post(actions.login, { fields, ip, cookies, headers, url: 'http://localhost/login' });

/** What `tailscale serve` adds to a request from a tailnet device (tried on 1.104). */
const viaTailscale = (device: string) => ({ 'x-forwarded-for': device, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'friend@example.com', 'tailscale-headers-info': 'https://tailscale.com/s/serve-headers' });

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

	// Behind Caddy (ADDRESS_HEADER), a sign-in from the machine's own browser has no
	// X-Forwarded-For, and adapter-node's getClientAddress() throws for it.
	it('signs in a request without the address header, as this machine', async () => {
		const me = owner();
		const cookies = cookieJar();
		const missing = new Error('Address header was specified with ADDRESS_HEADER=X-Forwarded-For but is absent from request');
		const result = await signIn({ username: 'admin', password: OWNER_PASSWORD, next: '/' }, missing, cookies);
		expect(result).toEqual({ redirect: '/' });
		expect(sessionUser(cookies.values.get(SESSION_COOKIE))).toMatchObject({ id: me.id });
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

// For a home network the owner trusts, the plain-http warning can be turned off (Settings > System).
describe('the sign-in page', () => {
	it('warns about plain http unless that was turned off', async () => {
		owner();
		expect(await load(page, { url: 'http://localhost/login' })).toMatchObject({ plainHttpWarning: true });
		setPlainHttpWarning(false);
		try {
			expect(await load(page, { url: 'http://localhost/login' })).toMatchObject({ plainHttpWarning: false });
		} finally {
			setPlainHttpWarning(true);
		}
	});

	// Behind `tailscale serve` every request comes from 127.0.0.1: one device's wrong passwords locked out everyone.
	it('counts tries through Tailscale against the tailnet device, and a forged header from anywhere else against the sender', async () => {
		owner();
		const device = () => `100.${crypto.randomInt(64, 128)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
		const guesser = device();
		for (let i = 0; i < 10; i++) expect(await signIn({ username: 'admin', password: 'wrong' }, '127.0.0.1', cookieJar(), viaTailscale(guesser))).toMatchObject({ status: 401 });
		expect(await signIn({ username: 'admin', password: OWNER_PASSWORD }, '127.0.0.1', cookieJar(), viaTailscale(guesser))).toMatchObject({ status: 429 });
		expect(await signIn({ username: 'admin', password: OWNER_PASSWORD }, '127.0.0.1', cookieJar(), viaTailscale(device()))).toEqual({ redirect: '/' });

		// From the LAN the headers are the sender's to make up: its own address counts.
		const lan = address();
		for (let i = 0; i < 10; i++) {
			expect(await signIn({ username: 'admin', password: 'wrong' }, lan, cookieJar(), viaTailscale(device()))).toMatchObject({ status: 401 });
		}
		expect(await signIn({ username: 'admin', password: OWNER_PASSWORD }, lan, cookieJar(), viaTailscale(device()))).toMatchObject({ status: 429 });
	});
});
