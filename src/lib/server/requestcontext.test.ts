import { describe, expect, it } from 'vitest';
import { desc } from 'drizzle-orm';
import { runAs } from './requestcontext';
import { audit } from './instances';
import { startTask, getTask } from './tasks';
import { db } from './db';
import { auditLog } from './db/schema';

const last = () => db.select().from(auditLog).orderBy(desc(auditLog.id)).get()!;
const alice = { id: 'user-alice', username: 'alice' };

describe('who did it, in the audit log', () => {
	it("records the account of the request the work came from, through awaits and timers", async () => {
		await runAs(alice, async () => {
			audit('test.direct');
			expect(last()).toMatchObject({ action: 'test.direct', userId: 'user-alice', username: 'alice' });
			await new Promise((r) => setTimeout(r, 5));
			audit('test.later');
		});
		expect(last()).toMatchObject({ action: 'test.later', userId: 'user-alice' });
	});

	it('also in a background task the request started, after the request is long done', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const id = runAs(alice, () =>
			startTask({ label: 'install', instanceId: null }, async () => {
				await gate;
				audit('test.task');
			})
		);
		release();
		while (getTask(id)?.state === 'running') await new Promise((r) => setTimeout(r, 5));
		expect(last()).toMatchObject({ action: 'test.task', username: 'alice' });
	});

	it("leaves MineShell's own work (no request) without an account", () => {
		audit('test.scheduler', { actor: 'scheduler' });
		expect(last()).toMatchObject({ action: 'test.scheduler', userId: null, username: null, actor: 'scheduler' });
		runAs(null, () => audit('test.auth-off'));
		expect(last()).toMatchObject({ action: 'test.auth-off', userId: null });
	});
});
