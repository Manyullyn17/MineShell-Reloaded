import crypto from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import { db } from './db';
import { instanceAccess, instancePlayerAccess, sessions, users } from './db/schema';
import { hashPassword, randomPassword } from './crypto';
import { destroyUserSessions } from './auth';
import { isInstancePermission, type Access, type InstancePermission } from '#lib/shared/access.js';

/**
 * Managing accounts (MineShell settings > Accounts): creating them, their
 * flags, one-time passwords, disabling, and their access per server. Signing
 * in and sessions are auth.ts; what access means is lib/shared/access.ts.
 *
 * A new account and a reset one get a random password, shown once to whoever
 * made it and never stored readable; the account must pick its own before it
 * can do anything else (guard.ts). Disabling or resetting an account signs it
 * out everywhere.
 */

export class AccountError extends Error {}

/** 2-32 characters: letters, digits, and `_ . -` after the first. */
export const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Account = {
	id: string;
	username: string;
	isOwner: boolean;
	isGlobalAdmin: boolean;
	canCreate: boolean;
	disabled: boolean;
	mustChangePassword: boolean;
	createdAt: number;
	/** Open sessions. */
	sessions: number;
};

const columns = {
	id: users.id,
	username: users.username,
	isOwner: users.isOwner,
	isGlobalAdmin: users.isGlobalAdmin,
	canCreate: users.canCreate,
	disabledAt: users.disabledAt,
	mustChangePassword: users.mustChangePassword,
	createdAt: users.createdAt
};

function toAccount(row: { disabledAt: number | null } & Omit<Account, 'disabled' | 'sessions'>): Account {
	const { disabledAt, ...rest } = row;
	const open = db.select({ n: count() }).from(sessions).where(eq(sessions.userId, row.id)).get()?.n ?? 0;
	return { ...rest, disabled: disabledAt !== null, sessions: open };
}

/** Every account, the owner first, then by name. */
export function listAccounts(): Account[] {
	return db
		.select(columns)
		.from(users)
		.all()
		.map(toAccount)
		.sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.username.localeCompare(b.username));
}

export function getAccount(id: string): Account | null {
	const row = db.select(columns).from(users).where(eq(users.id, id)).get();
	return row ? toAccount(row) : null;
}

/**
 * Whether `actor` may change `target` from Accounts. The owner is changed by
 * nobody there (its own password is on its account page); a global admin only
 * by the owner, who alone makes and unmakes them; everyone else by any global admin.
 */
export function mayManage(actor: Access, target: Pick<Account, 'isOwner' | 'isGlobalAdmin'>): boolean {
	if (target.isOwner) return false;
	if (target.isGlobalAdmin) return actor.owner;
	return actor.globalAdmin;
}

/** A new account with a one-time password, returned for showing once. */
export function createAccount(username: string, flags: { globalAdmin: boolean; canCreate: boolean }): { account: Account; password: string } {
	const name = username.trim();
	if (!USERNAME.test(name)) {
		throw new AccountError('A username is 2-32 letters, digits, dots, dashes or underscores, starting with a letter or digit.');
	}
	const password = randomPassword();
	const now = Date.now();
	const id = crypto.randomUUID();
	try {
		db.insert(users)
			.values({
				id,
				username: name,
				passwordHash: hashPassword(password),
				isGlobalAdmin: flags.globalAdmin,
				canCreate: flags.canCreate,
				mustChangePassword: true,
				createdAt: now,
				updatedAt: now
			})
			.run();
	} catch (err) {
		// The name index ignores case, so "Steve" clashes with "steve" too.
		if (err instanceof Error && /UNIQUE/.test(err.message)) throw new AccountError(`There is already an account called ${name}.`);
		throw err;
	}
	return { account: getAccount(id)!, password };
}

/** A new one-time password for the account (returned for showing once); signs it out everywhere. */
export function resetAccountPassword(id: string): string {
	const password = randomPassword();
	db.update(users)
		.set({ passwordHash: hashPassword(password), mustChangePassword: true, updatedAt: Date.now() })
		.where(eq(users.id, id))
		.run();
	destroyUserSessions(id);
	return password;
}

/** Disabling signs the account out everywhere; it cannot sign in until enabled again. */
export function setAccountDisabled(id: string, disabled: boolean): void {
	db.update(users)
		.set({ disabledAt: disabled ? Date.now() : null, updatedAt: Date.now() })
		.where(eq(users.id, id))
		.run();
	if (disabled) destroyUserSessions(id);
}

/** Global admin and "may create servers". Taking global admin away leaves the account's access per server as it was. */
export function setAccountFlags(id: string, flags: { globalAdmin: boolean; canCreate: boolean }): void {
	db.update(users)
		.set({ isGlobalAdmin: flags.globalAdmin, canCreate: flags.canCreate, updatedAt: Date.now() })
		.where(eq(users.id, id))
		.run();
}

/** Deletes the account, its sessions and its access (the database cascades them). */
export function deleteAccount(id: string): void {
	db.delete(users).where(eq(users.id, id)).run();
}

// ------------------------------------------------------------------ access ---

/** An account's access to one server, as the access editor shows and sends it. */
export type GrantForm = {
	admin: boolean;
	permissions: InstancePermission[];
	playerView: 'none' | 'all' | 'selected';
	playerEdit: 'none' | 'all' | 'selected';
	/** With "selected": the players. */
	viewUuids: string[];
	editUuids: string[];
};

/** The account's access per server, by server id. */
export function grantsOf(userId: string): Record<string, GrantForm> {
	const players = db.select().from(instancePlayerAccess).where(eq(instancePlayerAccess.userId, userId)).all();
	const out: Record<string, GrantForm> = {};
	for (const row of db.select().from(instanceAccess).where(eq(instanceAccess.userId, userId)).all()) {
		const mine = players.filter((p) => p.instanceId === row.instanceId);
		let permissions: InstancePermission[] = [];
		try {
			const parsed: unknown = JSON.parse(row.permissions);
			if (Array.isArray(parsed)) permissions = parsed.filter(isInstancePermission);
		} catch {
			/* none */
		}
		out[row.instanceId] = {
			admin: row.isAdmin,
			permissions,
			playerView: row.playerView,
			playerEdit: row.playerEdit,
			viewUuids: row.playerView === 'selected' ? mine.map((p) => p.uuid) : [],
			editUuids: row.playerEdit === 'selected' ? mine.filter((p) => p.canEdit).map((p) => p.uuid) : []
		};
	}
	return out;
}

/**
 * Saves an account's access to a server. Made instance admin, its listed
 * permissions and player scopes are kept as they were, so taking admin away
 * later gives exactly those back.
 */
export function saveGrant(userId: string, instanceId: string, grant: GrantForm): void {
	const bad = [...grant.viewUuids, ...grant.editUuids].find((u) => !UUID.test(u));
	if (bad) throw new AccountError(`${bad} is not a player UUID.`);
	db.transaction((tx) => {
		const now = Date.now();
		const where = and(eq(instanceAccess.userId, userId), eq(instanceAccess.instanceId, instanceId));
		const existing = tx.select().from(instanceAccess).where(where).get();
		if (grant.admin && existing) {
			tx.update(instanceAccess).set({ isAdmin: true, updatedAt: now }).where(where).run();
			return;
		}
		const fields = {
			isAdmin: grant.admin,
			permissions: JSON.stringify([...new Set(grant.permissions.filter(isInstancePermission))]),
			playerView: grant.playerView,
			playerEdit: grant.playerEdit,
			updatedAt: now
		};
		if (existing) tx.update(instanceAccess).set(fields).where(where).run();
		else tx.insert(instanceAccess).values({ userId, instanceId, ...fields }).run();

		tx.delete(instancePlayerAccess)
			.where(and(eq(instancePlayerAccess.userId, userId), eq(instancePlayerAccess.instanceId, instanceId)))
			.run();
		// One row per player; editing includes viewing, so an edit row stands for both.
		const edit = new Set(grant.playerEdit === 'selected' ? grant.editUuids : []);
		const view = new Set(grant.playerView === 'selected' ? grant.viewUuids : []);
		for (const uuid of new Set([...view, ...edit])) {
			tx.insert(instancePlayerAccess).values({ userId, instanceId, uuid, canEdit: edit.has(uuid) }).run();
		}
	});
}

/**
 * Whoever adds or copies a server becomes its admin (a copy never takes the
 * source's access list: the server is new, so it has none).
 */
export function makeCreatorAdmin(userId: string, instanceId: string): void {
	saveGrant(userId, instanceId, { admin: true, permissions: [], playerView: 'none', playerEdit: 'none', viewUuids: [], editUuids: [] });
}

/** No access to that server any more: its permissions and players go too. */
export function removeGrant(userId: string, instanceId: string): void {
	db.delete(instanceAccess).where(and(eq(instanceAccess.userId, userId), eq(instanceAccess.instanceId, instanceId))).run();
}
