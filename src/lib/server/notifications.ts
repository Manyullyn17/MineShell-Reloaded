import { eq } from 'drizzle-orm';
import { db } from './db';
import { instanceNotifications, settings } from './db/schema';
import { decryptSecret, encryptSecret } from './crypto';
import { assertPublicUrl, USER_AGENT } from './download';
import { BlockedDownloadError } from './downloadaccess';
import {
	DEFAULT_NOTIFICATION_KINDS,
	NOTIFICATION_KINDS,
	TARGET_TYPES,
	type NotificationKind,
	type TargetType,
	type TargetView
} from '#lib/shared/notifications.js';
import { outboundFetch } from './outbound';

/**
 * Messages about servers to Discord (a channel's webhook), ntfy (phone
 * notifications) or any webhook taking JSON. MineShell has one destination
 * (MineShell settings > Notifications); a server can have its own instead,
 * or beside it. Each destination has the kinds it is sent.
 *
 * The callers (history.ts, the scheduler, updatecheck.ts) only report what
 * happened as it happens; nothing older than a few minutes is sent, so the
 * history catching up after MineShell was down does not post a backlog.
 * Repeats of a problem (a crash loop) within FOLD_MS are counted into the
 * next message instead of each sent.
 */

export type Notification = {
	kind: NotificationKind;
	instance: { id: string; name: string };
	title: string;
	message: string;
	at: number;
};

type Target = { type: TargetType; url: string; kinds: NotificationKind[] };

const GLOBAL_KEY = 'notifications';
const KINDS = new Set(NOTIFICATION_KINDS.map((k) => k.kind));

/**
 * Kinds added after destinations could be saved, on by default: a saved
 * destination gets them too unless they were turned off, which is stored as
 * `!kind` (older versions skip what they do not know).
 */
const ADDED_LATER: NotificationKind[] = ['backup'];

function cleanKinds(input: unknown): NotificationKind[] {
	if (!Array.isArray(input)) return [...DEFAULT_NOTIFICATION_KINDS];
	const kinds = input.filter((k): k is NotificationKind => KINDS.has(k));
	for (const kind of ADDED_LATER) {
		if (!kinds.includes(kind) && !input.includes(`!${kind}`) && DEFAULT_NOTIFICATION_KINDS.includes(kind)) kinds.push(kind);
	}
	return kinds;
}

/** The kinds as stored: the ones on, and `!kind` for each later one turned off (cleanKinds). */
function storedKinds(input: NotificationKind[]): string[] {
	const kinds = input.filter((k) => KINDS.has(k));
	return [...kinds, ...ADDED_LATER.filter((k) => !kinds.includes(k)).map((k) => `!${k}`)];
}

/** Why an address cannot be used for this kind of destination, or null when it can. */
export function targetProblem(type: string, url: string): string | null {
	if (!TARGET_TYPES.some((t) => t.type === type)) return 'Pick where to send them.';
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'That is not a web address.';
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'The address has to start with https://.';
	if (type === 'discord' && !(/(^|\.)discord(app)?\.com$/.test(parsed.hostname) && parsed.pathname.startsWith('/api/webhooks/'))) {
		return "That is not a Discord webhook address (https://discord.com/api/webhooks/...). Copy it from the channel's webhook settings.";
	}
	if (type === 'ntfy' && parsed.pathname.split('/').filter(Boolean).length !== 1) {
		return 'An ntfy address is the server and the topic: https://ntfy.sh/your-topic.';
	}
	return null;
}

/** What a saved address shows as: enough to recognise it, not enough to use it. */
function addressHint(type: TargetType, url: string): string {
	const parsed = new URL(url);
	if (type === 'discord') return `Discord webhook ${parsed.pathname.split('/')[3] ?? ''}`;
	if (type === 'ntfy') {
		const topic = parsed.pathname.slice(1);
		return `${parsed.host}/${topic.slice(0, 3)}${'•'.repeat(Math.min(8, Math.max(0, topic.length - 3)))}`;
	}
	return `${parsed.host}${parsed.pathname.length > 1 ? '/…' : ''}`;
}

// ------------------------------------------------------------- storage ---

export function globalTarget(): Target | null {
	const raw = db.select().from(settings).where(eq(settings.key, GLOBAL_KEY)).get()?.value;
	try {
		const stored = JSON.parse(raw ?? 'null') as { type?: string; urlEnc?: string; kinds?: unknown } | null;
		const url = decryptSecret(stored?.urlEnc);
		if (!stored || !url || targetProblem(String(stored.type), url)) return null;
		return { type: stored.type as TargetType, url, kinds: cleanKinds(stored.kinds) };
	} catch {
		return null;
	}
}

/** Saves MineShell's destination; a null url keeps the saved address (the form never holds it). */
export function saveGlobalTarget(input: { type: TargetType; url: string | null; kinds: NotificationKind[] }): string | null {
	const url = input.url ?? globalTarget()?.url ?? null;
	if (!url) return 'Paste the address to send to.';
	const problem = targetProblem(input.type, url);
	if (problem) return problem;
	const value = JSON.stringify({ type: input.type, urlEnc: encryptSecret(url), kinds: storedKinds(input.kinds) });
	db.insert(settings).values({ key: GLOBAL_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
	return null;
}

export function removeGlobalTarget(): void {
	db.delete(settings).where(eq(settings.key, GLOBAL_KEY)).run();
	lastResults.delete('global');
}

export type ServerTarget = Target & { alsoGlobal: boolean };

export function serverTarget(instanceId: string): ServerTarget | null {
	const row = db.select().from(instanceNotifications).where(eq(instanceNotifications.instanceId, instanceId)).get();
	const url = decryptSecret(row?.urlEnc);
	if (!row || !url || targetProblem(row.type, url)) return null;
	let kinds: unknown = null;
	try {
		kinds = JSON.parse(row.kinds);
	} catch {
		/* the defaults */
	}
	return { type: row.type as TargetType, url, kinds: cleanKinds(kinds), alsoGlobal: row.alsoGlobal };
}

export function saveServerTarget(
	instanceId: string,
	input: { type: TargetType; url: string | null; kinds: NotificationKind[]; alsoGlobal: boolean }
): string | null {
	const url = input.url ?? serverTarget(instanceId)?.url ?? null;
	if (!url) return 'Paste the address to send to.';
	const problem = targetProblem(input.type, url);
	if (problem) return problem;
	const row = { type: input.type, urlEnc: encryptSecret(url), kinds: JSON.stringify(storedKinds(input.kinds)), alsoGlobal: input.alsoGlobal };
	db.insert(instanceNotifications)
		.values({ instanceId, ...row })
		.onConflictDoUpdate({ target: instanceNotifications.instanceId, set: row })
		.run();
	return null;
}

export function removeServerTarget(instanceId: string): void {
	db.delete(instanceNotifications).where(eq(instanceNotifications.instanceId, instanceId)).run();
	lastResults.delete(instanceId);
}

/** A copied server sends where its source did. */
export function copyServerTarget(fromId: string, toId: string): void {
	const row = db.select().from(instanceNotifications).where(eq(instanceNotifications.instanceId, fromId)).get();
	if (row) db.insert(instanceNotifications).values({ ...row, instanceId: toId }).onConflictDoNothing().run();
}

const lastResults = new Map<string, { at: number; ok: boolean; message: string }>();

export function targetView(key: 'global' | string, target: Target | null): (TargetView & { kinds: NotificationKind[] }) | null {
	if (!target) return null;
	return { type: target.type, hint: addressHint(target.type, target.url), kinds: target.kinds, lastResult: lastResults.get(key) ?? null };
}

// ------------------------------------------------------------- sending ---

/** Only what happened this recently is sent: older events are the history catching up. */
export const FRESH_MS = 5 * 60_000;
const FOLD_MS = 10 * 60_000;
const FOLDED = new Set<NotificationKind>(['crash', 'memory', 'stuck']);
const folds = new Map<string, { sentAt: number; skipped: number }>();

const COLORS: Record<NotificationKind, number> = {
	crash: 0xd9534f,
	memory: 0xd9534f,
	stuck: 0xf0ad4e,
	backup: 0xd9534f,
	update: 0x5b8def,
	restart: 0x8a8f98,
	start: 0x4caf50,
	stop: 0x8a8f98,
	join: 0x4caf50,
	leave: 0x8a8f98
};
const NTFY_TAGS: Record<NotificationKind, string> = {
	crash: 'rotating_light',
	memory: 'warning',
	stuck: 'hourglass',
	backup: 'floppy_disk',
	update: 'package',
	restart: 'arrows_counterclockwise',
	start: 'white_check_mark',
	stop: 'stop_sign',
	join: 'wave',
	leave: 'door'
};

function request(target: Target, n: Notification): { url: string; body: string; type: string } {
	const heading = `${n.instance.name}: ${n.title}`;
	if (target.type === 'discord') {
		return {
			url: target.url,
			type: 'application/json',
			body: JSON.stringify({
				username: 'MineShell',
				embeds: [{ title: heading.slice(0, 256), description: n.message.slice(0, 4000), color: COLORS[n.kind], timestamp: new Date(n.at).toISOString() }],
				// Player names and log text must never ping anyone.
				allowed_mentions: { parse: [] }
			})
		};
	}
	if (target.type === 'ntfy') {
		const parsed = new URL(target.url);
		return {
			url: `${parsed.origin}/`,
			type: 'application/json',
			body: JSON.stringify({
				topic: parsed.pathname.slice(1),
				title: heading,
				message: n.message,
				tags: [NTFY_TAGS[n.kind]],
				priority: FOLDED.has(n.kind) ? 4 : 3
			})
		};
	}
	return {
		url: target.url,
		type: 'application/json',
		body: JSON.stringify({ event: n.kind, server: n.instance, title: n.title, message: n.message, at: new Date(n.at).toISOString() })
	};
}

/** Sends one message; the answer is kept for the settings page. Never throws. */
export async function send(key: string, target: Target, n: Notification): Promise<{ ok: boolean; message: string }> {
	const result = await sendOnce(target, n).catch((err: unknown) => ({
		ok: false,
		message:
			err instanceof BlockedDownloadError && err.blocked
				? `Not sent: ${err.blocked.host} is ${err.blocked.kind}. The owner or a global admin can allow ${err.blocked.address} under MineShell settings > System.`
				: `Not sent: ${err instanceof Error ? err.message : 'the request failed'}.`
	}));
	lastResults.set(key, { at: Date.now(), ...result });
	if (!result.ok) console.warn(`[mineshell] notification to ${target.type} failed: ${result.message}`);
	return result;
}

async function sendOnce(target: Target, n: Notification): Promise<{ ok: boolean; message: string }> {
	const { url, body, type } = request(target, n);
	await assertPublicUrl(url);
	for (let attempt = 0; ; attempt++) {
		const response = await outboundFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': type, 'User-Agent': USER_AGENT },
			body,
			redirect: 'error',
			signal: AbortSignal.timeout(10_000)
		});
		// Discord's rate limit: wait what it says, once.
		if (response.status === 429 && attempt === 0) {
			const after = Number((await response.json().catch(() => null))?.retry_after ?? response.headers.get('retry-after') ?? 1);
			await new Promise((r) => setTimeout(r, Math.min(10_000, Math.max(0.5, after) * 1000)));
			continue;
		}
		if (response.ok) return { ok: true, message: 'Sent.' };
		const text = (await response.text().catch(() => '')).slice(0, 200);
		return { ok: false, message: `Not sent: the destination answered ${response.status}${text ? ` (${text})` : ''}.` };
	}
}

/** Where a server's notification of this kind goes. */
export function destinations(instanceId: string, kind: NotificationKind): { key: string; target: Target }[] {
	const own = serverTarget(instanceId);
	const global = globalTarget();
	const out: { key: string; target: Target }[] = [];
	if (own && own.kinds.includes(kind)) out.push({ key: instanceId, target: own });
	if (global && (!own || own.alsoGlobal) && global.kinds.includes(kind)) out.push({ key: 'global', target: global });
	return out;
}

/**
 * Reports something that happened. Fire and forget: callers are mid-way
 * through their own work, and a slow destination must not hold them up.
 */
export function notify(n: Notification, now = Date.now()): Promise<void> {
	if (now - n.at > FRESH_MS) return Promise.resolve();
	const targets = destinations(n.instance.id, n.kind);
	if (!targets.length) return Promise.resolve();
	let message = n.message;
	if (FOLDED.has(n.kind)) {
		const key = `${n.instance.id}:${n.kind}`;
		const fold = folds.get(key);
		if (fold && now - fold.sentAt < FOLD_MS) {
			fold.skipped++;
			return Promise.resolve();
		}
		if (fold?.skipped) message += `\n\n(${fold.skipped} more like this since the last message.)`;
		folds.set(key, { sentAt: now, skipped: 0 });
	}
	return Promise.all(targets.map(({ key, target }) => send(key, target, { ...n, message }))).then(() => undefined);
}

/** A test message to one destination, for the settings pages. */
export function sendTest(key: string, target: Target, server: { id: string; name: string }): Promise<{ ok: boolean; message: string }> {
	return send(key, target, {
		kind: 'start',
		instance: server,
		title: 'Test message',
		message: 'Notifications from MineShell arrive here.',
		at: Date.now()
	});
}

/** Forgets repeat counting, for tests. */
export function resetFolds(): void {
	folds.clear();
}
