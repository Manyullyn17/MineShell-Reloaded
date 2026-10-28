export type VersionOption = {
	value: string;
	label: string;
	/** Set where the value is not a version number (a pack or mod version's id): its channel says. */
	prerelease?: boolean;
};

/** Betas, alphas, release candidates and snapshots: "0.29.0-beta.3", "25w14a", "1.21.5-pre2". */
export function isPrerelease(version: string): boolean {
	return /alpha|beta|-pre|-rc|snapshot|^\d+w\d+[a-z]$/i.test(version);
}

/**
 * What a typed text leaves: versions starting with it first ("1.20" -> the 1.20.x), then the
 * ones holding it anywhere ("2864" -> 14.23.5.2864), each in the list's order.
 */
export function filterVersions<T extends VersionOption>(options: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return options;
	const starts: T[] = [];
	const holds: T[] = [];
	for (const option of options) {
		const text = option.label.toLowerCase();
		if (text.startsWith(q)) starts.push(option);
		else if (text.includes(q)) holds.push(option);
	}
	return [...starts, ...holds];
}

export type VersionGroup = { heading: string | null; options: VersionOption[] };

/**
 * The list as shown: an option without a value ("Latest (...)") on top unless filtering,
 * then the matches, releases apart from pre-releases when there are both.
 */
export function versionGroups(options: VersionOption[], query: string): VersionGroup[] {
	const pinned = query.trim() ? [] : options.filter((o) => o.value === '');
	const rest = filterVersions(
		options.filter((o) => o.value !== ''),
		query
	);
	const pre = (o: VersionOption) => o.prerelease ?? isPrerelease(o.value);
	const releases = rest.filter((o) => !pre(o));
	const betas = rest.filter(pre);
	const groups: VersionGroup[] = [];
	if (pinned.length) groups.push({ heading: null, options: pinned });
	if (releases.length && betas.length) {
		groups.push({ heading: 'Releases', options: releases }, { heading: 'Betas and snapshots', options: betas });
	} else if (rest.length) {
		groups.push({ heading: null, options: rest });
	}
	return groups;
}
