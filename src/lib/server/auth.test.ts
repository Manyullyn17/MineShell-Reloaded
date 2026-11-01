import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	createOwner,
	createSession,
	destroyUserSessions,
	loginThrottled,
	recordFailedLogin,
	sessionCookieName,
	sessionCookieOptions,
	sessionUser,
	setPassword,
	setupCode,
	setupCodeMatches,
	throttleAddress,
	verifyLogin
} from './auth';
import { db } from './db';
import { users } from './db/schema';
import { OWNER_PASSWORD, otherUser, owner } from '../../../tests/helpers/auth';

describe('sessionCookieOptions', () => {
	const req = (headers: Record<string, string> = {}) => new Request('http://x/', { headers });

	it('is Secure on https, directly or behind a TLS-terminating proxy', () => {
		expect(sessionCookieOptions(req(), new URL('https://mc.example/')).secure).toBe(true);
		expect(sessionCookieOptions(req({ 'x-forwarded-proto': 'https' }), new URL('http://127.0.0.1:3000/')).secure).toBe(true);
		expect(sessionCookieOptions(req({ 'x-forwarded-proto': 'https, http' }), new URL('http://127.0.0.1:3000/')).secure).toBe(true);
	});

	it('is not Secure on plain http (LAN by IP), where a Secure cookie would never be sent back', () => {
		expect(sessionCookieOptions(req(), new URL('http://192.168.0.200:5173/')).secure).toBe(false);
	});

	it("follows the browser's Origin, not the URL adapter-node reports as https on plain http", () => {
		expect(sessionCookieOptions(req({ origin: 'http://mc-server:3000' }), new URL('https://mc-server:3000/login')).secure).toBe(false);
		expect(sessionCookieOptions(req({ origin: 'https://mc.example' }), new URL('https://mc.example/login')).secure).toBe(true);
		expect(sessionCookieOptions(req({ origin: 'http://127.0.0.1:3000', 'x-forwarded-proto': 'https' }), new URL('http://127.0.0.1:3000/')).secure).toBe(true);
	});

	it('is http-only, same-site lax and lasts 30 days', () => {
		expect(sessionCookieOptions(req(), new URL('http://x/'))).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 });
	});
});

describe('sessionCookieName', () => {
	it('differs between data folders, so two MineShells on one host keep their own sign-ins', () => {
		expect(sessionCookieName('/home/a/.local/share/mineshell')).not.toBe(sessionCookieName('/home/a/mineshell-data'));
	});

	it('is the same every start for one data folder, and a valid cookie name', () => {
		expect(sessionCookieName('/srv/mineshell')).toBe(sessionCookieName('/srv/mineshell'));
		expect(sessionCookieName('/srv/mineshell')).toMatch(/^mineshell_session_[0-9a-f]{12}$/);
	});
});

describe('accounts', () => {
	it('signs in by name (any case) and password; a wrong pair, an unknown name or a disabled account gets nothing', () => {
		const account = owner();
		expect(verifyLogin('admin', OWNER_PASSWORD)).toEqual({ id: account.id, username: 'admin', isOwner: true, mustChangePassword: false });
		expect(verifyLogin(' Admin ', OWNER_PASSWORD)?.id).toBe(account.id);
		expect(verifyLogin('admin', 'wrong-password')).toBeNull();
		expect(verifyLogin('nobody', OWNER_PASSWORD)).toBeNull();
		const disabled = otherUser({ disabledAt: Date.now() });
		expect(verifyLogin(disabled.username, OWNER_PASSWORD)).toBeNull();
	});

	it("changes one account's password only", () => {
		const account = owner();
		const other = otherUser();
		setPassword(account.id, 'a-new-password');
		expect(verifyLogin('admin', 'a-new-password')).not.toBeNull();
		expect(verifyLogin(other.username, OWNER_PASSWORD)).not.toBeNull();
		expect(() => setPassword(account.id, 'short')).toThrow(/at least 8/);
	});

	it('has one owner, which setup cannot make twice and the database will not delete, demote or disable', () => {
		const account = owner();
		expect(() => createOwner('another-password')).toThrow(/already set up/);
		expect(() => db.delete(users).where(eq(users.id, account.id)).run()).toThrow(/cannot be deleted/);
		expect(() => db.update(users).set({ isOwner: false }).where(eq(users.id, account.id)).run()).toThrow(/cannot be demoted/);
		expect(() => db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, account.id)).run()).toThrow(/cannot be demoted or disabled/);
		const other = otherUser();
		expect(() => db.update(users).set({ isOwner: true }).where(eq(users.id, other.id)).run()).toThrow(/UNIQUE/);
		expect(() => otherUser({ username: 'ADMIN' })).toThrow(/UNIQUE/);
	});

	it('signs an account out everywhere but the session asking', () => {
		const account = owner();
		const other = otherUser();
		const here = createSession(account.id, null).id;
		const elsewhere = createSession(account.id, null).id;
		const theirs = createSession(other.id, null).id;
		destroyUserSessions(account.id, here);
		expect(sessionUser(here)?.id).toBe(account.id);
		expect(sessionUser(elsewhere)).toBeNull();
		expect(sessionUser(theirs)?.id).toBe(other.id);
	});
});

describe('login throttle', () => {
	it('stops an address after 10 failures, and a name after 50 from any address', () => {
		for (let i = 0; i < 10; i++) recordFailedLogin('10.0.0.1', 'throttle-a');
		expect(loginThrottled('10.0.0.1', 'someone-else')).toBe(true);
		expect(loginThrottled('10.0.0.2', 'throttle-a')).toBe(false);
		for (let i = 0; i < 50; i++) recordFailedLogin(`10.1.0.${i}`, 'Throttle-B');
		expect(loginThrottled('10.2.0.1', 'throttle-b')).toBe(true);
	});
});

describe('the login throttle', () => {
	it('counts IPv6 per /64, which one client usually holds whole', () => {
		expect(throttleAddress('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
		expect(throttleAddress('2001:0db8:0001:0002:ffff:1:2:3')).toBe('2001:db8:1:2::/64');
		expect(throttleAddress('2001:db8::5')).toBe('2001:db8:0:0::/64');
		expect(throttleAddress('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
		expect(throttleAddress('::1')).toBe('0:0:0:0::/64');
		expect(throttleAddress('::ffff:192.168.1.5')).toBe('192.168.1.5');
		expect(throttleAddress('203.0.113.9')).toBe('203.0.113.9');
	});

	it('stops a guesser who moves to another address of the same /64', () => {
		const name = `nobody-${Date.now()}`;
		for (let i = 0; i < 10; i++) recordFailedLogin(`2001:db8:9:9::${i + 1}`, `${name}-${i}`);
		expect(loginThrottled('2001:db8:9:9:ffff::77', `${name}-other`)).toBe(true);
		expect(loginThrottled('2001:db8:9:a::1', `${name}-other`)).toBe(false);
	});
});

describe('the setup code', () => {
	it('is the same until used, and matched whatever its case and dashes', () => {
		const code = setupCode();
		expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		expect(setupCode()).toBe(code);
		expect(setupCodeMatches(code)).toBe(true);
		expect(setupCodeMatches(code.toLowerCase().replace(/-/g, ' '))).toBe(true);
		expect(setupCodeMatches('')).toBe(false);
		expect(setupCodeMatches('AAAA-AAAA-AAAA')).toBe(code === 'AAAA-AAAA-AAAA');
	});
});
