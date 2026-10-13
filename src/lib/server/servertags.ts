import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { instanceTags, serverTags } from './db/schema';

export function findServerTag(id: string) {
	return db.select().from(serverTags).where(eq(serverTags.id, id)).get();
}

/** Creates a shared tag or returns the existing tag with the same case-insensitive name. */
export function createOrFindServerTag(name: string) {
	db.insert(serverTags)
		.values({ id: randomUUID(), name })
		.onConflictDoNothing()
		.run();
	return db.select().from(serverTags).where(sql`lower(${serverTags.name}) = lower(${name})`).get();
}

export function assignServerTag(instanceId: string, tagId: string): void {
	db.insert(instanceTags).values({ instanceId, tagId }).onConflictDoNothing().run();
}

/** Removes one assignment and prunes the shared tag if it has no remaining assignments. */
export function removeServerTag(instanceId: string, tagId: string): void {
	db.transaction((tx) => {
		tx.delete(instanceTags).where(and(eq(instanceTags.instanceId, instanceId), eq(instanceTags.tagId, tagId))).run();
		if (!tx.select().from(instanceTags).where(eq(instanceTags.tagId, tagId)).get()) {
			tx.delete(serverTags).where(eq(serverTags.id, tagId)).run();
		}
	});
}
