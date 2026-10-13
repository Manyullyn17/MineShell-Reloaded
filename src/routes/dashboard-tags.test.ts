import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { actions } from './+page.server';
import { db } from '#lib/server/db/index.js';
import { instanceTags, serverTags } from '#lib/server/db/schema.js';
import { createInstance } from '../../tests/helpers/instances';

async function post(action: (event: never) => unknown, fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return await action({ request: new Request('http://localhost/', { method: 'POST', body: form }) } as never);
}

describe('dashboard server tag actions', () => {
	it('creates a tag, reuses it across servers, and prunes it after the last removal', async () => {
		const first = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const second = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });

		const created = await post(actions.addTag as (event: never) => unknown, { id: first.id, name: 'Nightly' });
		expect(created).toMatchObject({ ok: true, message: expect.stringContaining('Nightly') });
		const tag = db.select().from(serverTags).where(eq(serverTags.name, 'Nightly')).get();
		expect(tag).toBeDefined();

		// Names are case-insensitive, and assigning a tag twice is idempotent.
		expect(await post(actions.addTag as (event: never) => unknown, { id: first.id, name: 'nightly' })).toMatchObject({ ok: true });
		expect(db.select().from(instanceTags).where(and(eq(instanceTags.instanceId, first.id), eq(instanceTags.tagId, tag!.id))).all()).toHaveLength(1);

		// The tag picker submits an existing tag ID when applying a shared tag.
		expect(await post(actions.addTag as (event: never) => unknown, { id: second.id, tagId: tag!.id })).toMatchObject({ ok: true });
		await post(actions.removeTag as (event: never) => unknown, { id: first.id, tagId: tag!.id });
		expect(db.select().from(serverTags).where(eq(serverTags.id, tag!.id)).get()).toBeDefined();

		await post(actions.removeTag as (event: never) => unknown, { id: second.id, tagId: tag!.id });
		expect(db.select().from(serverTags).where(eq(serverTags.id, tag!.id)).get()).toBeUndefined();
	});

	it('rejects invalid new names and stale existing tag IDs', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const invalidName = await post(actions.addTag as (event: never) => unknown, { id: instance.id, name: '   ' });
		expect(invalidName).toMatchObject({ status: 400 });

		const staleTag = await post(actions.addTag as (event: never) => unknown, { id: instance.id, tagId: 'missing-tag-id' });
		expect(staleTag).toMatchObject({ status: 404 });
	});
});
