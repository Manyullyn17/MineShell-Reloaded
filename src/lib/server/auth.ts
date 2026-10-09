import crypto from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from './db';
import { sessions, settings } from './db/schema';
import { hashPassword, verifyPassword } from './crypto';
import { AUTH_ENABLED } from './config';

/**
 * One admin password, one cookie. The design notes flagged auth as open: this is
 * the minimal hedge against network creep (a guest device, a stray port forward)
 * without turning a single-user LAN tool into an identity system. Set
 * MINESHELL_AUTH=off to skip it entirely.
 */

export const SESSION_COOKIE = 'mineshell_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_KEY = 'auth.password_hash';

/**
 * Session cookie settings. Secure when the browser used https - directly, or
 * as reported by a TLS-terminating reverse proxy (X-Forwarded-Proto), where the
 * app itself only sees http.
 *
 * "Directly" is the scheme in the browser's Origin header (sent with every form
 * post), not `url.protocol`: adapter-node cannot see the scheme and reports
 * https unless told otherwise, so a production MineShell on plain http set a
 * Secure cookie the browser dropped, and signing in did nothing.
 */
export function sessionCookieOptions(request: Request, url: URL) {
	const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase();
	const origin = request.headers.get('origin');
	const browserProtocol = origin && origin !== 'null' ? URL.parse(origin)?.protocol : url.protocol;
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: browserProtocol === 'https:' || forwarded === 'https',
		maxAge: SESSION_TTL_MS / 1000
	};
}

export function authEnabled(): boolean {
	return AUTH_ENABLED;
}

export function passwordIsSet(): boolean {
	const row = db.select().from(settings).where(eq(settings.key, PASSWORD_KEY)).get();
	return Boolean(row?.value);
}

export function setPassword(password: string): void {
	if (password.length < 8) {
		throw new Error('Use a password of at least 8 characters.');
	}
	const value = hashPassword(password);
	db.insert(settings)
		.values({ key: PASSWORD_KEY, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } })
		.run();
}

export function checkPassword(password: string): boolean {
	const row = db.select().from(settings).where(eq(settings.key, PASSWORD_KEY)).get();
	if (!row) return false;
	try {
		return verifyPassword(password, row.value);
	} catch {
		return false;
	}
}

export function createSession(userAgent: string | null): { id: string; expiresAt: number } {
	pruneSessions();
	const id = crypto.randomBytes(32).toString('base64url');
	const expiresAt = Date.now() + SESSION_TTL_MS;
	db.insert(sessions)
		.values({ id, createdAt: Date.now(), expiresAt, userAgent })
		.run();
	return { id, expiresAt };
}

export function sessionValid(id: string | undefined): boolean {
	if (!id) return false;
	const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
	if (!row) return false;
	if (row.expiresAt < Date.now()) {
		db.delete(sessions).where(eq(sessions.id, id)).run();
		return false;
	}
	return true;
}

export function destroySession(id: string | undefined): void {
	if (id) db.delete(sessions).where(eq(sessions.id, id)).run();
}

export function destroyAllSessions(): void {
	db.delete(sessions).run();
}

function pruneSessions(): void {
	db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
}

/** Simple per-IP throttle so the login form is not worth brute-forcing. */
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

export function loginThrottled(ip: string): boolean {
	const entry = attempts.get(ip);
	if (!entry || entry.resetAt < Date.now()) return false;
	return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedLogin(ip: string): void {
	const entry = attempts.get(ip);
	if (!entry || entry.resetAt < Date.now()) {
		attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
	} else {
		entry.count += 1;
	}
}

export function clearLoginAttempts(ip: string): void {
	attempts.delete(ip);
}

export { and };
