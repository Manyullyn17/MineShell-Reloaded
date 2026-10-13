import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	AccountError,
	createAccount,
	deleteAccount,
	getAccount,
	grantsOf,
	mayManage,
	removeGrant,
	resetAccountPassword,
	saveGrant,
	setAccountDisabled
} from './accounts';
import { createSession, sessionUser, verifyLogin } from './auth';
import { loadAccess } from './access';
import { db } from './db';
import { instancePlayerAccess, users } from './db/schema';
import { FULL_ACCESS, NO_ACCESS, type Access } from '#lib/shared/access.js';
import { owner } from '../../../tests/helpers/auth';
import { createInstance } from '../../../tests/helpers/instances';

const STEVE = '8667ba71-b85a-4004-af54-457a9734eed7';
const ALEX = 'ec561538-f3fd-461d-aff5-086b22154bce';
let n = 0;
const name = () => `acct${process.pid}x${++n}`;
const server = () => createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });

describe('accounts', () => {
	it('are made with a one-time password that signs in once and must be replaced', () => {
		const { account, password } = createAccount(name(), { globalAdmin: false, canCreate: true });
		expect(account).toMatchObject({ isOwner: false, isGlobalAdmin: false, canCreate: true, mustChangePassword: true, disabled: false });
		expect(password.length).toBeGreaterThanOrEqual(20);
		expect(verifyLogin(account.username, password)).toMatchObject({ id: account.id, mustChangePassword: true });
	});

	it('need a proper name that nobody has, in any case', () => {
		owner();
		const taken = name();
		createAccount(taken, { globalAdmin: false, canCreate: false });
		expect(() => createAccount(taken.toUpperCase(), { globalAdmin: false, canCreate: false })).toThrow(AccountError);
		expect(() => createAccount('a', { globalAdmin: false, canCreate: false })).toThrow(AccountError);
		expect(() => createAccount('no spaces', { globalAdmin: false, canCreate: false })).toThrow(AccountError);
		expect(() => createAccount('Admin', { globalAdmin: false, canCreate: false })).toThrow(AccountError);
	});

	it('reset gives a new one-time password and signs the account out everywhere', () => {
		const { account, password } = createAccount(name(), { globalAdmin: false, canCreate: false });
		const session = createSession(account.id, null).id;
		const fresh = resetAccountPassword(account.id);
		expect(verifyLogin(account.username, password)).toBeNull();
		expect(verifyLogin(account.username, fresh)).toMatchObject({ mustChangePassword: true });
		expect(sessionUser(session)).toBeNull();
	});

	it('disabled ones are signed out and cannot sign in until enabled; their access stays', async () => {
		const { id } = await server();
		const { account, password } = createAccount(name(), { globalAdmin: false, canCreate: false });
		saveGrant(account.id, id, { admin: false, permissions: ['power'], playerView: 'none', playerEdit: 'none', viewUuids: [], editUuids: [] });
		const session = createSession(account.id, null).id;
		setAccountDisabled(account.id, true);
		expect(sessionUser(session)).toBeNull();
		expect(verifyLogin(account.username, password)).toBeNull();
		setAccountDisabled(account.id, false);
		expect(verifyLogin(account.username, password)).not.toBeNull();
		expect(grantsOf(account.id)[id].permissions).toEqual(['power']);
	});

	it('deleting one takes its access along; the owner cannot be deleted', async () => {
		const { id } = await server();
		const { account } = createAccount(name(), { globalAdmin: false, canCreate: false });
		saveGrant(account.id, id, { admin: false, permissions: [], playerView: 'selected', playerEdit: 'none', viewUuids: [STEVE], editUuids: [] });
		deleteAccount(account.id);
		expect(getAccount(account.id)).toBeNull();
		expect(db.select().from(instancePlayerAccess).where(eq(instancePlayerAccess.userId, account.id)).all()).toEqual([]);
		expect(() => deleteAccount(owner().id)).toThrow(/cannot be deleted/);
	});
});

describe('who may manage whom', () => {
	const admin: Access = { ...NO_ACCESS, globalAdmin: true, canCreate: true };
	it('nobody the owner; only the owner a global admin; any global admin everyone else', () => {
		expect(mayManage(FULL_ACCESS, { isOwner: true, isGlobalAdmin: true })).toBe(false);
		expect(mayManage(FULL_ACCESS, { isOwner: false, isGlobalAdmin: true })).toBe(true);
		expect(mayManage(admin, { isOwner: false, isGlobalAdmin: true })).toBe(false);
		expect(mayManage(admin, { isOwner: false, isGlobalAdmin: false })).toBe(true);
		expect(mayManage(NO_ACCESS, { isOwner: false, isGlobalAdmin: false })).toBe(false);
	});
});

describe('access per server', () => {
	it('saves permissions and player scopes as access reads them', async () => {
		const { id } = await server();
		const { account } = createAccount(name(), { globalAdmin: false, canCreate: false });
		saveGrant(account.id, id, {
			admin: false,
			permissions: ['power', 'console.read', 'power'],
			playerView: 'selected',
			playerEdit: 'selected',
			viewUuids: [STEVE, ALEX],
			editUuids: [STEVE]
		});
		const user = { ...account, mustChangePassword: false };
		const grant = loadAccess(user).instances[id];
		expect(grant.permissions).toEqual(['power', 'console.read']);
		expect(grant.playerEdit).toEqual([STEVE]);
		expect(grant.playerView).toEqual([ALEX]);
		expect(grantsOf(account.id)[id]).toMatchObject({ viewUuids: expect.arrayContaining([STEVE, ALEX]), editUuids: [STEVE] });
	});

	it('keeps the chosen permissions under instance admin, and gives them back when it is taken away', async () => {
		const { id } = await server();
		const { account } = createAccount(name(), { globalAdmin: false, canCreate: false });
		const chosen = { permissions: ['files' as const], playerView: 'all' as const, playerEdit: 'none' as const, viewUuids: [], editUuids: [] };
		saveGrant(account.id, id, { admin: false, ...chosen });
		// The editor sends no permissions while "Admin" is picked.
		saveGrant(account.id, id, { admin: true, permissions: [], playerView: 'none', playerEdit: 'none', viewUuids: [], editUuids: [] });
		expect(grantsOf(account.id)[id]).toMatchObject({ admin: true, permissions: ['files'], playerView: 'all' });
		saveGrant(account.id, id, { ...grantsOf(account.id)[id], admin: false });
		expect(grantsOf(account.id)[id]).toMatchObject({ admin: false, permissions: ['files'], playerView: 'all' });
	});

	it('refuses what is not a UUID, and "no access" removes it all', async () => {
		const { id } = await server();
		const { account } = createAccount(name(), { globalAdmin: false, canCreate: false });
		expect(() => saveGrant(account.id, id, { admin: false, permissions: [], playerView: 'selected', playerEdit: 'none', viewUuids: ['Steve'], editUuids: [] })).toThrow(AccountError);
		saveGrant(account.id, id, { admin: false, permissions: ['power'], playerView: 'selected', playerEdit: 'none', viewUuids: [STEVE], editUuids: [] });
		removeGrant(account.id, id);
		expect(grantsOf(account.id)).toEqual({});
		expect(db.select().from(instancePlayerAccess).where(eq(instancePlayerAccess.userId, account.id)).all()).toEqual([]);
		expect(db.select().from(users).where(eq(users.id, account.id)).get()).toBeDefined();
	});
});
