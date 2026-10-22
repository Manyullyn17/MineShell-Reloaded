/** What a form needs to know about snapshotting before a risky operation (server: snapshotPrompt). */
export type SnapshotPromptView = {
	worldBytes: number;
	/** About what a snapshot would add on disk, files shared with the last one left out. */
	neededBytes: number;
	ask: boolean;
	asksBySize: boolean;
	freeBytes: number | null;
	lowSpace: boolean;
	policy: { keepMin: number; partialMin: number; budgetMb: number; askAboveMb: number; minFreeMb: number };
};

/**
 * The snapshot policy as a settings form shows it: GB for the sizes, '' for a
 * field not set, "never" for no size question and "off" for no free-space check.
 */
export type PolicyFormValues = {
	keepMin: string;
	keepMax: string;
	partialMin: string;
	partialMax: string;
	budgetGb: string;
	askAboveGb: string;
	minFreeGb: string;
};

type PolicyNumbers = { keepMin: number; keepMax: number; partialMin: number; partialMax: number; budgetMb: number; askAboveMb: number; minFreeMb: number };

const gb = (mb: number | undefined) => (mb === undefined ? '' : String(Math.round((mb / 1024) * 100) / 100));
const str = (n: number | undefined) => (n === undefined ? '' : String(n));

export function policyFormValues(policy: Partial<PolicyNumbers>): PolicyFormValues {
	return {
		keepMin: str(policy.keepMin),
		keepMax: str(policy.keepMax),
		partialMin: str(policy.partialMin),
		partialMax: str(policy.partialMax),
		budgetGb: gb(policy.budgetMb),
		askAboveGb: policy.askAboveMb === -1 ? 'never' : gb(policy.askAboveMb),
		minFreeGb: policy.minFreeMb === 0 ? 'off' : gb(policy.minFreeMb)
	};
}
