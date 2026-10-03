import { describe, expect, it } from 'vitest';
import { sessionCookieOptions } from './auth';

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

	it('is http-only, same-site lax and lasts 30 days', () => {
		expect(sessionCookieOptions(req(), new URL('http://x/'))).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 });
	});
});
