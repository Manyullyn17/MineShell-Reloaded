import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { instanceNotifications, settings } from './db/schema';
import {
	destinations,
	globalTarget,
	notify,
	removeGlobalTarget,
	resetFolds,
	saveGlobalTarget,
	saveServerTarget,
	serverTarget,
	targetProblem,
	targetView,
	type Notification
} from './notifications';
import { createInstance } from '../../../tests/helpers/instances';
import { useRecordedHttp } from '../../../tests/helpers/http';

const DISCORD = 'https://discord.com/api/webhooks/123456/secret-token';
const NTFY = 'https://ntfy.example/mineshell-topic';
const HOOK = 'https://hooks.example/in';

const received: { url: string; body: Record<string, unknown> }[] = [];
const answer = (url: string) => async (init?: RequestInit) => {
	received.push({ url, body: JSON.parse(String(init?.body)) });
	return new Response(null, { status: 204 });
};
useRecordedHttp('none', { extra: { [DISCORD]: answer(DISCORD), 'https://ntfy.example/': answer('ntfy'), [HOOK]: answer(HOOK) } });

const server = async () => {
	const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
	return { id: instance.id, name: instance.name };
};
const event = (instance: { id: string; name: string }, kind: Notification['kind'], at = Date.now()): Notification => ({
	kind,
	instance,
	title: 'Crashed',
	message: 'Killed at its memory limit (6144 MB)',
	at
});
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
	received.length = 0;
	resetFolds();
});
afterEach(() => removeGlobalTarget());

describe('destinations', () => {
	it('takes only addresses that fit the kind', () => {
		expect(targetProblem('discord', DISCORD)).toBeNull();
		expect(targetProblem('discord', 'https://example.com/api/webhooks/1/x')).toMatch(/not a Discord webhook/);
		expect(targetProblem('ntfy', NTFY)).toBeNull();
		expect(targetProblem('ntfy', 'https://ntfy.sh/')).toMatch(/server and the topic/);
		expect(targetProblem('webhook', 'ftp://x/y')).toMatch(/https/);
	});

	it('stores the address encrypted, shows only a hint, and keeps it when saved without one', () => {
		expect(saveGlobalTarget({ type: 'discord', url: DISCORD, kinds: ['crash'] })).toBeNull();
		const raw = db.select().from(settings).where(eq(settings.key, 'notifications')).get()!.value;
		expect(raw).not.toContain('secret-token');
		expect(targetView('global', globalTarget())).toMatchObject({ type: 'discord', hint: 'Discord webhook 123456', kinds: ['crash'] });
		expect(saveGlobalTarget({ type: 'discord', url: null, kinds: ['crash', 'update'] })).toBeNull();
		expect(globalTarget()).toEqual({ type: 'discord', url: DISCORD, kinds: ['crash', 'update'] });
	});

	it('turns a kind added later on for destinations saved before it, unless turned off since', async () => {
		const s = await server();
		saveServerTarget(s.id, { type: 'ntfy', url: NTFY, kinds: ['crash'], alsoGlobal: false });
		// As a version without failed backups or disk warnings saved it: only what was ticked then.
		db.update(instanceNotifications).set({ kinds: JSON.stringify(['crash']) }).where(eq(instanceNotifications.instanceId, s.id)).run();
		expect(serverTarget(s.id)?.kinds).toEqual(['crash', 'backup', 'disk']);
		// Saved now with it off: it stays off.
		saveServerTarget(s.id, { type: 'ntfy', url: null, kinds: ['crash'], alsoGlobal: false });
		expect(serverTarget(s.id)?.kinds).toEqual(['crash']);
	});

	it("sends a server's notifications to its own destination, MineShell's only when asked", async () => {
		const s = await server();
		expect(destinations(s.id, 'crash')).toEqual([]);
		saveGlobalTarget({ type: 'discord', url: DISCORD, kinds: ['crash'] });
		expect(destinations(s.id, 'crash').map((d) => d.key)).toEqual(['global']);
		expect(destinations(s.id, 'join')).toEqual([]);

		saveServerTarget(s.id, { type: 'ntfy', url: NTFY, kinds: ['crash', 'join'], alsoGlobal: false });
		expect(destinations(s.id, 'crash').map((d) => d.key)).toEqual([s.id]);
		saveServerTarget(s.id, { type: 'ntfy', url: null, kinds: ['crash', 'join'], alsoGlobal: true });
		expect(destinations(s.id, 'crash').map((d) => d.key)).toEqual([s.id, 'global']);
		// MineShell's own destination still sends only what is ticked there.
		expect(destinations(s.id, 'join').map((d) => d.key)).toEqual([s.id]);
		expect(serverTarget(s.id)?.url).toBe(NTFY);
		expect(db.select().from(instanceNotifications).where(eq(instanceNotifications.instanceId, s.id)).get()!.urlEnc).not.toContain('topic');
	});
});

describe('sending', () => {
	it('posts to Discord with no pings allowed, to ntfy by topic, and JSON to a webhook', async () => {
		const s = await server();
		saveGlobalTarget({ type: 'discord', url: DISCORD, kinds: ['crash'] });
		await notify(event(s, 'crash'));
		const discord = received.find((r) => r.url === DISCORD)!.body;
		expect(discord.allowed_mentions).toEqual({ parse: [] });
		expect((discord.embeds as { title: string }[])[0].title).toBe(`${s.name}: Crashed`);

		saveServerTarget(s.id, { type: 'ntfy', url: NTFY, kinds: ['memory'], alsoGlobal: false });
		await notify(event(s, 'memory'));
		expect(received.find((r) => r.url === 'ntfy')!.body).toMatchObject({ topic: 'mineshell-topic', title: `${s.name}: Crashed`, priority: 4 });

		saveServerTarget(s.id, { type: 'webhook', url: HOOK, kinds: ['update'], alsoGlobal: false });
		await notify(event(s, 'update'));
		expect(received.find((r) => r.url === HOOK)!.body).toMatchObject({ event: 'update', server: s, title: 'Crashed' });
	});

	it('does not send what happened long ago (the history catching up)', async () => {
		const s = await server();
		saveGlobalTarget({ type: 'discord', url: DISCORD, kinds: ['crash'] });
		await notify(event(s, 'crash', Date.now() - 60 * 60_000));
		await settle();
		expect(received).toEqual([]);
	});

	it('folds a crash loop into one message, counting the rest into the next', async () => {
		const s = await server();
		saveGlobalTarget({ type: 'discord', url: DISCORD, kinds: ['crash'] });
		const t0 = Date.now();
		await notify(event(s, 'crash', t0), t0);
		await notify(event(s, 'crash', t0 + 60_000), t0 + 60_000);
		await notify(event(s, 'crash', t0 + 120_000), t0 + 120_000);
		expect(received).toHaveLength(1);
		await notify(event(s, 'crash', t0 + 11 * 60_000), t0 + 11 * 60_000);
		expect(received).toHaveLength(2);
		expect((received[1].body.embeds as { description: string }[])[0].description).toContain('2 more like this');
	});
});
