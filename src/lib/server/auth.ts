import crypto from 'node:crypto';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { db } from './db';
import { sessions, users } from './db/schema';
import { hashPassword, verifyPassword } from './crypto';
import { AUTH_ENABLED, DATA_DIR } from './config';
import { bus } from './events';

/**
 * Accounts and sessions. The design notes flagged auth as open: it is on by
 * default as the hedge against network creep (a guest device, a stray port
 * forward). Set MINESHELL_AUTH=off to skip it entirely.
 *
 * One account so far: the owner, created by /setup (or migration 0019 from
 * the old single admin password) and named "admin". More accounts and their
 * permissions come later (docs/ROADMAP.md); the owner is told apart by its
 * `isOwner` row, never by its name, so renaming it stays possible.
 */

/** The owner's name. Fixed for now; a rename would only change the row. */
export const OWNER_USERNAME = 'admin';

/**
 * Who a session belongs to, as the rest of MineShell sees it. `mustChangePassword`:
 * it was given its password by someone else and may only pick its own (guard.ts).
 */
export type SessionUser = { id: string; username: string; isOwner: boolean; mustChangePassword: boolean };

/**
 * Browsers keep cookies per host, not per port: a production MineShell on
 * port 3000 and `npm run dev` on 5173 shared one cookie, and signing in to
 * either signed the other out. Each data folder holds its own sessions, so the
 * cookie is named after it.
 */
export function sessionCookieName(dataDir: string): string {
	return `mineshell_session_${crypto.createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`;
}

export const SESSION_COOKIE = sessionCookieName(DATA_DIR);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;

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

/** Whether setup has run: before it there is no account to sign in to. */
export function ownerExists(): boolean {
	return db.select({ id: users.id }).from(users).where(eq(users.isOwner, true)).get() !== undefined;
}

function checkNewPassword(password: string): void {
	if (password.length < MIN_PASSWORD) {
		throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
	}
}

const toSessionUser = (row: { id: string; username: string; isOwner: boolean; mustChangePassword: boolean }): SessionUser => ({
	id: row.id,
	username: row.username,
	isOwner: row.isOwner,
	mustChangePassword: row.mustChangePassword
});

/** /setup: the first account, the owner. Refused once there is one. */
export function createOwner(password: string): SessionUser {
	checkNewPassword(password);
	const passwordHash = hashPassword(password);
	return db.transaction((tx) => {
		if (tx.select({ id: users.id }).from(users).where(eq(users.isOwner, true)).get()) {
			throw new Error('MineShell is already set up.');
		}
		const now = Date.now();
		const row = { id: crypto.randomUUID(), username: OWNER_USERNAME, passwordHash, isOwner: true, mustChangePassword: false, createdAt: now, updatedAt: now };
		tx.insert(users).values(row).run();
		return toSessionUser(row);
	});
}

/** An account picking its own password (which ends a forced change). */
export function setPassword(userId: string, password: string): void {
	checkNewPassword(password);
	db.update(users)
		.set({ passwordHash: hashPassword(password), mustChangePassword: false, updatedAt: Date.now() })
		.where(eq(users.id, userId))
		.run();
}

/** Compared against when the name is unknown, so a miss takes as long as a wrong password. */
let decoyHash: string | null = null;

/** The account a name and password sign in to; null for a wrong pair or a disabled account. */
export function verifyLogin(username: string, password: string): SessionUser | null {
	const row = db
		.select()
		.from(users)
		.where(eq(sql`lower(${users.username})`, username.trim().toLowerCase()))
		.get();
	let matches: boolean;
	try {
		matches = verifyPassword(password, row?.passwordHash ?? (decoyHash ??= hashPassword(crypto.randomUUID())));
	} catch {
		matches = false;
	}
	if (!row || !matches || row.disabledAt !== null) return null;
	return toSessionUser(row);
}

/**
 * The only account's name while there is just one, for the login form to fill
 * in: an install from before accounts never had to type one.
 */
export function soleUsername(): string | null {
	const rows = db.select({ username: users.username }).from(users).limit(2).all();
	return rows.length === 1 ? rows[0].username : null;
}

export function createSession(userId: string, userAgent: string | null): { id: string; expiresAt: number } {
	pruneSessions();
	const id = crypto.randomBytes(32).toString('base64url');
	const expiresAt = Date.now() + SESSION_TTL_MS;
	db.insert(sessions)
		.values({ id, userId, createdAt: Date.now(), expiresAt, userAgent })
		.run();
	return { id, expiresAt };
}

/**
 * The account a session cookie signs in as: null when the session is unknown,
 * expired, or its account is disabled. Read on every request, so a deleted
 * session or a disabled account stops working at once.
 */
export function sessionUser(id: string | undefined): SessionUser | null {
	if (!id) return null;
	const row = db
		.select({
			expiresAt: sessions.expiresAt,
			id: users.id,
			username: users.username,
			isOwner: users.isOwner,
			mustChangePassword: users.mustChangePassword,
			disabledAt: users.disabledAt
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.id, id))
		.get();
	if (!row) return null;
	if (row.expiresAt < Date.now()) {
		db.delete(sessions).where(eq(sessions.id, id)).run();
		return null;
	}
	return row.disabledAt === null ? toSessionUser(row) : null;
}

export function destroySession(id: string | undefined): void {
	if (!id) return;
	db.delete(sessions).where(eq(sessions.id, id)).run();
	bus.publish('access:changed', { userId: null });
}

/** Signs an account out everywhere, except the session given in `keep` (the one asking). */
export function destroyUserSessions(userId: string, keep?: string): void {
	db.delete(sessions)
		.where(keep ? and(eq(sessions.userId, userId), ne(sessions.id, keep)) : eq(sessions.userId, userId))
		.run();
	bus.publish('access:changed', { userId });
}

/**
 * An account's open sessions, newest first, for its account page. The ids are
 * the cookies' values, so they stay here: `current` marks the one asking.
 */
export function listUserSessions(userId: string, currentId: string | undefined): { createdAt: number; userAgent: string | null; current: boolean }[] {
	return db
		.select()
		.from(sessions)
		.where(eq(sessions.userId, userId))
		.all()
		.filter((s) => s.expiresAt >= Date.now())
		.sort((a, b) => b.createdAt - a.createdAt)
		.map((s) => ({ createdAt: s.createdAt, userAgent: s.userAgent, current: s.id === currentId }));
}

function pruneSessions(): void {
	db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
}

/**
 * Failed sign-ins are counted per address (10 in 15 minutes) and per account
 * name (50): the per-account limit catches guessing spread over many
 * addresses, and is high enough that someone else cannot easily lock the
 * owner out by failing on purpose.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_PER_IP = 10;
const MAX_PER_ACCOUNT = 50;

const ipKey = (ip: string) => `ip:${ip}`;
const accountKey = (username: string) => `user:${username.trim().toLowerCase()}`;

function failures(key: string): number {
	const entry = attempts.get(key);
	return entry && entry.resetAt >= Date.now() ? entry.count : 0;
}

export function loginThrottled(ip: string, username: string): boolean {
	return failures(ipKey(ip)) >= MAX_PER_IP || failures(accountKey(username)) >= MAX_PER_ACCOUNT;
}

export function recordFailedLogin(ip: string, username: string): void {
	for (const key of [ipKey(ip), accountKey(username)]) {
		const entry = attempts.get(key);
		if (!entry || entry.resetAt < Date.now()) attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
		else entry.count += 1;
	}
}

/** After a successful sign-in: that address starts over. The account's count stays, since others may be guessing. */
export function clearLoginAttempts(ip: string): void {
	attempts.delete(ipKey(ip));
}

export { and };
