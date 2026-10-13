import crypto from 'node:crypto';
import { createOwner, ownerExists, setPassword, type SessionUser } from '#lib/server/auth.js';
import { hashPassword } from '#lib/server/crypto.js';
import { db } from '#lib/server/db/index.js';
import { instanceAccess, instancePlayerAccess, users } from '#lib/server/db/schema.js';
import type { InstancePermission } from '#lib/shared/access.js';
import { and, eq } from 'drizzle-orm';

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

/** Gives an account access to a server, replacing what it had there. */
export function grant(
	userId: string,
	instanceId: string,
	access: {
		admin?: boolean;
		permissions?: InstancePermission[];
		playerView?: 'none' | 'all' | string[];
		playerEdit?: 'none' | 'all' | string[];
	}
): void {
	const kind = (scope: 'none' | 'all' | string[] | undefined) => (Array.isArray(scope) ? 'selected' : (scope ?? 'none'));
	db.delete(instanceAccess).where(and(eq(instanceAccess.userId, userId), eq(instanceAccess.instanceId, instanceId))).run();
	db.insert(instanceAccess)
		.values({
			userId,
			instanceId,
			isAdmin: access.admin ?? false,
			permissions: JSON.stringify(access.permissions ?? []),
			playerView: kind(access.playerView),
			playerEdit: kind(access.playerEdit),
			updatedAt: Date.now()
		})
		.run();
	const players = [
		...(Array.isArray(access.playerView) ? access.playerView.map((uuid) => ({ uuid, canEdit: false })) : []),
		...(Array.isArray(access.playerEdit) ? access.playerEdit.map((uuid) => ({ uuid, canEdit: true })) : [])
	];
	for (const p of players) db.insert(instancePlayerAccess).values({ userId, instanceId, ...p }).run();
}

/** Global flags on an account other than the owner. */
export function setAccountFlags(userId: string, flags: { globalAdmin?: boolean; canCreate?: boolean }): void {
	db.update(users)
		.set({ isGlobalAdmin: flags.globalAdmin ?? false, canCreate: flags.canCreate ?? false })
		.where(eq(users.id, userId))
		.run();
}
