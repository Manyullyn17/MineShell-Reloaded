import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSession, destroySession } from './auth';
import { db } from './db';
import { mapTokens, serverInstances, users } from './db/schema';
import { mapRequest, mapToken, mapTokenAccess, withShim } from './mapframe';
import { grant, otherUser } from '../../../tests/helpers/auth';
import { createInstance } from '../../../tests/helpers/instances';

/**
 * The Map tab's frames carry no cookie (they are sandboxed), so a token in
 * their path says whose view it is: it must end when that view should.
 */

const server = () => createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
const refusal = (run: () => unknown) => {
	try {
		run();
	} catch (err) {
		return (err as { status?: number }).status;
	}
	return null;
};

describe('map tokens', () => {
	it("give the session's account its own access on one server, and end with the session", async () => {
		const instance = await server();
		const viewer = otherUser();
		grant(viewer.id, instance.id, { permissions: ['view'] });
		const session = createSession(viewer.id, null).id;
		const token = mapToken(session, instance.id);

		expect(mapToken(session, instance.id)).toBe(token);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(mapTokenAccess(token)).toMatchObject({ instanceId: instance.id, access: { owner: false } });
		expect(mapRequest(token, 'view').id).toBe(instance.id);
		expect(refusal(() => mapRequest(token, 'map.render'))).toBe(403);

		destroySession(session);
		expect(mapTokenAccess(token)).toBeNull();
		expect(refusal(() => mapRequest(token, 'view'))).toBe(403);
	});

	it('stop for an account disabled or made to pick a new password, whose session row stays', async () => {
		const instance = await server();
		for (const change of [{ disabledAt: Date.now() }, { mustChangePassword: true }]) {
			const viewer = otherUser();
			grant(viewer.id, instance.id, { permissions: ['view'] });
			const token = mapToken(createSession(viewer.id, null).id, instance.id);
			expect(mapTokenAccess(token)).not.toBeNull();
			db.update(users).set(change).where(eq(users.id, viewer.id)).run();
			expect(mapTokenAccess(token), JSON.stringify(change)).toBeNull();
		}
	});

	it('follow access taken away, and go with their server', async () => {
		const instance = await server();
		const viewer = otherUser();
		grant(viewer.id, instance.id, { permissions: ['view'] });
		const token = mapToken(createSession(viewer.id, null).id, instance.id);
		db.delete(serverInstances).where(eq(serverInstances.id, instance.id)).run();
		expect(db.select().from(mapTokens).where(eq(mapTokens.token, token)).get()).toBeUndefined();

		const other = await server();
		const stranger = otherUser();
		expect(refusal(() => mapRequest(mapToken(createSession(stranger.id, null).id, other.id), 'view'))).toBe(403);
	});

	it('are refused when made up, malformed or unused for half a day', async () => {
		const instance = await server();
		for (const token of ['', 'x', '../../etc', 'A'.repeat(43)]) expect(mapTokenAccess(token), token).toBeNull();
		const token = mapToken(null, instance.id);
		db.update(mapTokens).set({ usedAt: Date.now() - 13 * 60 * 60 * 1000 }).where(eq(mapTokens.token, token)).run();
		expect(mapTokenAccess(token)).toBeNull();
		expect(mapToken(null, instance.id)).not.toBe(token);
	});
});

describe('the storage shim', () => {
	it('goes first into the head, or first of all without one', () => {
		expect(withShim('<!DOCTYPE html><html><head lang="x"><script src="app.js"></script></head></html>')).toMatch(
			/^<!DOCTYPE html><html><head lang="x"><script>\(\(\) => \{[\s\S]*\}\)\(\);<\/script><script src="app.js">/
		);
		expect(withShim('<p>bare</p>')).toMatch(/^<script>[\s\S]*<\/script><p>bare<\/p>$/);
	});
});
