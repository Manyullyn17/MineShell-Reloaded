/** Update checks (lib/server/updatecheck.ts), as the settings form and the overview see them. */
export type UpdateKind = 'pack' | 'loader';
export type UpdateChannel = 'release' | 'beta' | 'alpha';

export const UPDATE_CHANNELS: UpdateChannel[] = ['release', 'beta', 'alpha'];

export const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
	release: 'Releases',
	beta: 'Betas too',
	alpha: 'Alphas too'
};

/**
 * Forge has no beta builds, but a recommended one: up to it counts as a
 * release, anything newer as a beta, and the settings say so in Forge's terms
 * (its download page: Recommended, Latest).
 */
export const FORGE_CHANNEL_LABELS: Partial<Record<UpdateChannel, string>> = {
	release: 'Recommended',
	beta: 'Latest too'
};

/** The channels a server's setting offers: Forge has two. */
export function channelsFor(loader: string | null): UpdateChannel[] {
	return loader === 'forge' ? ['release', 'beta'] : UPDATE_CHANNELS;
}

export function channelLabel(channel: UpdateChannel, loader: string | null): string {
	return (loader === 'forge' ? FORGE_CHANNEL_LABELS[channel] : undefined) ?? UPDATE_CHANNEL_LABELS[channel];
}

/** What a found version's channel adds to its name in a notice: nothing for a release. */
export function channelNote(channel: string, loader: string | null): string | null {
	if (channel === 'release') return null;
	return loader === 'forge' ? 'not yet recommended' : channel;
}

/** How often a server may be checked, in hours. */
export const UPDATE_CHECK_HOURS: { hours: number; label: string }[] = [
	{ hours: 6, label: 'Every 6 hours' },
	{ hours: 12, label: 'Every 12 hours' },
	{ hours: 24, label: 'Daily' },
	{ hours: 72, label: 'Every 3 days' },
	{ hours: 168, label: 'Weekly' }
];
