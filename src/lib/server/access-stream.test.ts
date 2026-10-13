import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { guardStream, STREAM_RECHECK_MS } from './access';
import { createSession, destroySession, destroyUserSessions, SESSION_COOKIE } from './auth';
import { removeGrant } from './accounts';
import { db } from './db';
import { sessions } from './db/schema';
import { can, FULL_ACCESS } from '#lib/shared/access.js';
import { grant, otherUser } from '../../../tests/helpers/auth';
import { createInstance } from '../../../tests/helpers/instances';
import * as tasksApi from '../../routes/api/tasks/+server';

afterEach(() => vi.useRealTimers());

/** An event stream's request: signed in as `user` with that session. */
function streamEvent(user: ReturnType<typeof otherUser>, session: string) {
	return {
		locals: { authRequired: true, authenticated: true, user, access: FULL_ACCESS } as App.Locals,
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? session : undefined) }
	};
}

describe('an open stream', () => {
	it('closes when its session is signed out, at once', () => {
		const user = otherUser();
		const session = createSession(user.id, null).id;
		const lost = vi.fn();
		guardStream(streamEvent(user, session), () => true, lost);
		// Signed out everywhere else: this one stays.
		destroyUserSessions(user.id, session);
		expect(lost).not.toHaveBeenCalled();
		destroySession(session);
		expect(lost).toHaveBeenCalledTimes(1);
	});

	it('closes when the access it needs is taken away, and not before', async () => {
		const { id } = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const user = otherUser();
		grant(user.id, id, { permissions: ['console.read'] });
		const session = createSession(user.id, null).id;
		const lost = vi.fn();
		const stop = guardStream(streamEvent(user, session), (access) => can(access, id, 'console.read'), lost);
		grant(user.id, id, { permissions: ['console.read', 'power'] });
		removeGrant(user.id, 'some-other-server');
		expect(lost).not.toHaveBeenCalled();
		removeGrant(user.id, id);
		expect(lost).toHaveBeenCalledTimes(1);
		stop();
	});

	it('notices what nobody announced (a session gone from the database) within the recheck time', () => {
		vi.useFakeTimers();
		const user = otherUser();
		const session = createSession(user.id, null).id;
		const lost = vi.fn();
		const stop = guardStream(streamEvent(user, session), () => true, lost);
		db.delete(sessions).where(eq(sessions.id, session)).run();
		expect(lost).not.toHaveBeenCalled();
		vi.advanceTimersByTime(STREAM_RECHECK_MS);
		expect(lost).toHaveBeenCalledTimes(1);
		stop();
	});

	it("Activity's stream ends when its account is signed out", async () => {
		const user = otherUser();
		const session = createSession(user.id, null).id;
		const response = await (tasksApi.GET as (e: never) => Promise<Response>)({
			url: new URL('http://localhost/api/tasks?stream=1&brief=1'),
			...streamEvent(user, session)
		} as never);
		const reader = response.body!.getReader();
		expect((await reader.read()).done).toBe(false);
		destroyUserSessions(user.id);
		expect((await reader.read()).done).toBe(true);
	});
});
