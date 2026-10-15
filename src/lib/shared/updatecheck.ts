/** Update checks (lib/server/updatecheck.ts), as the settings form and the overview see them. */
export type UpdateKind = 'pack' | 'loader';
export type UpdateChannel = 'release' | 'beta' | 'alpha';

export const UPDATE_CHANNELS: UpdateChannel[] = ['release', 'beta', 'alpha'];

export const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
	release: 'Releases only',
	beta: 'Releases and betas',
	alpha: 'Everything, alphas too'
};

/** How often a server may be checked, in hours. */
export const UPDATE_CHECK_HOURS: { hours: number; label: string }[] = [
	{ hours: 6, label: 'Every 6 hours' },
	{ hours: 12, label: 'Every 12 hours' },
	{ hours: 24, label: 'Daily' },
	{ hours: 72, label: 'Every 3 days' },
	{ hours: 168, label: 'Weekly' }
];
