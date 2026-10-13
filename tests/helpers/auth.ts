import crypto from 'node:crypto';
import { createOwner, ownerExists, setPassword, type SessionUser } from '#lib/server/auth.js';
import { hashPassword } from '#lib/server/crypto.js';
import { db } from '#lib/server/db/index.js';
import { users } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export const OWNER_PASSWORD = 'correct-horse';

/**
 * The owner account, with OWNER_PASSWORD. The test database outlives a test
 * file, and the owner cannot be deleted (migration 0019's triggers), so it is
 * made once and its password put back each time.
 */
export function owner(): SessionUser {
	if (!ownerExists()) return createOwner(OWNER_PASSWORD);
	const row = db.select().from(users).where(eq(users.isOwner, true)).get()!;
	setPassword(row.id, OWNER_PASSWORD);
	return { id: row.id, username: row.username, isOwner: true };
}

/** A second account (password OWNER_PASSWORD), inserted directly: there is no way to add one in the app yet. */
export function otherUser(fields: { username?: string; disabledAt?: number | null } = {}): SessionUser {
	const now = Date.now();
	const row = {
		id: crypto.randomUUID(),
		username: fields.username ?? `user-${crypto.randomUUID().slice(0, 8)}`,
		passwordHash: hashPassword(OWNER_PASSWORD),
		isOwner: false,
		disabledAt: fields.disabledAt ?? null,
		createdAt: now,
		updatedAt: now
	};
	db.insert(users).values(row).run();
	return { id: row.id, username: row.username, isOwner: false };
}
