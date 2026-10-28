/** Notifications (lib/server/notifications.ts), as the settings forms see them. */
export type NotificationKind = 'crash' | 'memory' | 'stuck' | 'backup' | 'disk' | 'update' | 'restart' | 'start' | 'stop' | 'join' | 'leave';

export const NOTIFICATION_KINDS: { kind: NotificationKind; label: string; defaultOn: boolean }[] = [
	{ kind: 'crash', label: 'Crashed', defaultOn: true },
	{ kind: 'memory', label: 'Killed for its memory', defaultOn: true },
	{ kind: 'stuck', label: 'Stuck starting (10 minutes without finishing)', defaultOn: true },
	{ kind: 'backup', label: 'Snapshot or backup copy failed or skipped', defaultOn: true },
	{ kind: 'disk', label: 'Disk running low', defaultOn: true },
	{ kind: 'update', label: 'Update found', defaultOn: true },
	{ kind: 'restart', label: 'Scheduled restart', defaultOn: false },
	{ kind: 'start', label: 'Finished starting', defaultOn: false },
	{ kind: 'stop', label: 'Stopped', defaultOn: false },
	{ kind: 'join', label: 'Player joined', defaultOn: false },
	{ kind: 'leave', label: 'Player left', defaultOn: false }
];

export const DEFAULT_NOTIFICATION_KINDS: NotificationKind[] = NOTIFICATION_KINDS.filter((k) => k.defaultOn).map((k) => k.kind);

/** What quiet hours hold back: news, not problems. Updates still go out (each set is sent once). */
export const QUIET_KINDS: NotificationKind[] = ['restart', 'start', 'stop', 'join', 'leave'];

/** HH:MM to HH:MM on the machine's clock; `from` after `to` runs past midnight. */
export type QuietHours = { from: string; to: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/** Why these quiet hours cannot be saved, or null. */
export function quietHoursProblem(quiet: QuietHours): string | null {
	if (!TIME.test(quiet.from) || !TIME.test(quiet.to)) return 'Give quiet hours a start and an end time.';
	if (quiet.from === quiet.to) return 'Quiet hours have to end at another time than they start.';
	return null;
}

/** Quiet hours as the settings forms hold them; off starts from 22:00 to 08:00 when switched on. */
export function quietValues(quiet: QuietHours | null): { quietOn: boolean; quietFrom: string; quietTo: string } {
	return { quietOn: !!quiet, quietFrom: quiet?.from ?? '22:00', quietTo: quiet?.to ?? '08:00' };
}

export function inQuietHours(quiet: QuietHours | null, at: Date): boolean {
	if (!quiet || quietHoursProblem(quiet)) return false;
	const now = at.getHours() * 60 + at.getMinutes();
	const from = minutes(quiet.from);
	const to = minutes(quiet.to);
	return from < to ? now >= from && now < to : now >= from || now < to;
}

export type TargetType = 'discord' | 'ntfy' | 'webhook';

export const TARGET_TYPES: { type: TargetType; label: string; placeholder: string; hint: string }[] = [
	{
		type: 'discord',
		label: 'Discord',
		placeholder: 'https://discord.com/api/webhooks/…',
		hint: "In Discord: Server Settings > Integrations > Webhooks > New Webhook, pick the channel, then Copy Webhook URL."
	},
	{
		type: 'ntfy',
		label: 'ntfy',
		placeholder: 'https://ntfy.sh/your-topic',
		hint: 'Push notifications on a phone. In the ntfy app, subscribe to a topic; paste its address here. On ntfy.sh anyone who knows the topic can read it, so make it long and random.'
	},
	{
		type: 'webhook',
		label: 'Webhook',
		placeholder: 'https://…',
		hint: 'Any address that takes a JSON POST per event: { event, server: { id, name }, title, message, at }.'
	}
];

/** A destination as the forms show it: the address itself is never sent back to the browser. */
export type TargetView = { type: TargetType; hint: string; lastResult: { at: number; ok: boolean; message: string } | null };
