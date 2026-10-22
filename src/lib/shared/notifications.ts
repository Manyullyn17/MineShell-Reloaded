/** Notifications (lib/server/notifications.ts), as the settings forms see them. */
export type NotificationKind = 'crash' | 'memory' | 'stuck' | 'backup' | 'update' | 'restart' | 'start' | 'stop' | 'join' | 'leave';

export const NOTIFICATION_KINDS: { kind: NotificationKind; label: string; defaultOn: boolean }[] = [
	{ kind: 'crash', label: 'Crashed', defaultOn: true },
	{ kind: 'memory', label: 'Killed for its memory', defaultOn: true },
	{ kind: 'stuck', label: 'Stuck starting (10 minutes without finishing)', defaultOn: true },
	{ kind: 'backup', label: 'Snapshot or backup copy failed', defaultOn: true },
	{ kind: 'update', label: 'Update found', defaultOn: true },
	{ kind: 'restart', label: 'Scheduled restart', defaultOn: false },
	{ kind: 'start', label: 'Finished starting', defaultOn: false },
	{ kind: 'stop', label: 'Stopped', defaultOn: false },
	{ kind: 'join', label: 'Player joined', defaultOn: false },
	{ kind: 'leave', label: 'Player left', defaultOn: false }
];

export const DEFAULT_NOTIFICATION_KINDS: NotificationKind[] = NOTIFICATION_KINDS.filter((k) => k.defaultOn).map((k) => k.kind);

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
