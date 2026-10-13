import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { instanceAccess, instancePlayerAccess, users } from './db/schema';
import { can, FULL_ACCESS, isInstancePermission, type Access, type InstanceGrant, type InstancePermission, type PlayerScope, type PlayerTarget } from '#lib/shared/access.js';
import type { SessionUser } from './auth';

/**
 * Loads an account's access (lib/shared/access.ts has the model) and checks
 * it inside handlers. Read fresh for every request: a change takes effect on
 * the next one. Which permission each route, action and endpoint needs is in
 * access/policy.ts, which the guard applies before anything runs; handlers only
 * check what depends on the request's contents (`requireAccess`).
 */

/** With MINESHELL_AUTH=off every request may do everything, as before accounts. */
export function loadAccess(user: SessionUser | null): Access {
	if (!user) return FULL_ACCESS;
	if (user.isOwner) return FULL_ACCESS;
	const row = db.select({ isGlobalAdmin: users.isGlobalAdmin, canCreate: users.canCreate }).from(users).where(eq(users.id, user.id)).get();
	if (!row) return { owner: false, globalAdmin: false, canCreate: false, instances: {} };
	if (row.isGlobalAdmin) return { owner: false, globalAdmin: true, canCreate: true, instances: {} };

	const chosen = new Map<string, { view: string[]; edit: string[] }>();
	for (const p of db.select().from(instancePlayerAccess).where(eq(instancePlayerAccess.userId, user.id)).all()) {
		const entry = chosen.get(p.instanceId) ?? { view: [], edit: [] };
		(p.canEdit ? entry.edit : entry.view).push(p.uuid);
		chosen.set(p.instanceId, entry);
	}
	const scope = (kind: 'none' | 'all' | 'selected', uuids: string[] | undefined): PlayerScope =>
		kind === 'selected' ? (uuids ?? []) : kind;

	const instances: Record<string, InstanceGrant> = {};
	for (const grant of db.select().from(instanceAccess).where(eq(instanceAccess.userId, user.id)).all()) {
		instances[grant.instanceId] = {
			admin: grant.isAdmin,
			permissions: parsePermissions(grant.permissions),
			playerView: scope(grant.playerView, chosen.get(grant.instanceId)?.view),
			playerEdit: scope(grant.playerEdit, chosen.get(grant.instanceId)?.edit)
		};
	}
	return { owner: false, globalAdmin: false, canCreate: row.canCreate, instances };
}

/** The stored JSON list, keeping only permissions that exist (a removed one grants nothing). */
function parsePermissions(json: string): InstancePermission[] {
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter(isInstancePermission) : [];
	} catch {
		return [];
	}
}

export const NO_ACCESS = 'You do not have access to that.';

/**
 * For a handler whose check depends on what was posted (which list, pin or
 * unpin, the task's server): throws 403 unless the account may.
 */
export function requireAccess(
	locals: App.Locals,
	instanceId: string,
	permission: InstancePermission | 'admin',
	player?: PlayerTarget
): void {
	if (!can(locals.access, instanceId, permission, player)) error(403, NO_ACCESS);
}

export function requireGlobalAdmin(locals: App.Locals): void {
	if (!locals.access.globalAdmin) error(403, NO_ACCESS);
}
