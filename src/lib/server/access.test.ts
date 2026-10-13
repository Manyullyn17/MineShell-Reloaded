import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { creatorId, loadAccess } from './access';
import { db } from './db';
import { instanceAccess, serverInstances, users } from './db/schema';
import { grant, otherUser, owner, setAccountFlags } from '../../../tests/helpers/auth';
import { createInstance } from '../../../tests/helpers/instances';

const STEVE = '8667ba71-b85a-4004-af54-457a9734eed7';
const server = () => createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });

describe('loadAccess', () => {
	it('gives the owner everything', () => {
		expect(loadAccess(owner())).toMatchObject({ owner: true, globalAdmin: true, canCreate: true });
	});

	it("reads an account's grants, player scopes and flags", async () => {
		const { id } = await server();
		const account = otherUser();
		grant(account.id, id, { permissions: ['power', 'console.read'], playerView: [STEVE], playerEdit: 'none' });
		setAccountFlags(account.id, { canCreate: true });
		expect(loadAccess(account)).toEqual({
			owner: false,
			globalAdmin: false,
			canCreate: true,
			instances: { [id]: { admin: false, permissions: ['power', 'console.read'], playerView: [STEVE], playerEdit: 'none' } }
		});
	});

	it('keeps the listed permissions when instance admin or global admin is taken away', async () => {
		const { id } = await server();
		const account = otherUser();
		grant(account.id, id, { admin: true, permissions: ['files'] });
		setAccountFlags(account.id, { globalAdmin: true });
		expect(loadAccess(account).globalAdmin).toBe(true);

		setAccountFlags(account.id, { globalAdmin: false });
		db.update(instanceAccess).set({ isAdmin: false }).where(eq(instanceAccess.userId, account.id)).run();
		expect(loadAccess(account).instances[id]).toMatchObject({ admin: false, permissions: ['files'] });
	});

	it('ignores permission ids it does not know', async () => {
		const { id } = await server();
		const account = otherUser();
		grant(account.id, id, {});
		db.update(instanceAccess).set({ permissions: '["power","made.up",42]' }).where(eq(instanceAccess.userId, account.id)).run();
		expect(loadAccess(account).instances[id].permissions).toEqual(['power']);
	});

	it("drops grants with the server or the account, so a new server of the same name starts with none", async () => {
		const { id } = await server();
		const account = otherUser();
		grant(account.id, id, { permissions: ['power'], playerEdit: [STEVE] });
		db.delete(serverInstances).where(eq(serverInstances.id, id)).run();
		expect(loadAccess(account).instances).toEqual({});

		const again = await server();
		grant(account.id, again.id, { permissions: ['power'] });
		db.delete(users).where(eq(users.id, account.id)).run();
		expect(db.select().from(instanceAccess).where(eq(instanceAccess.userId, account.id)).all()).toEqual([]);
	});
});

describe('creatorId', () => {
	it("is the account adding a server, but not the owner's (it has every server) nor anyone's with sign-in off", () => {
		const account = otherUser();
		expect(creatorId({ user: account } as App.Locals)).toBe(account.id);
		expect(creatorId({ user: owner() } as App.Locals)).toBeNull();
		expect(creatorId({ user: null } as App.Locals)).toBeNull();
	});
});
