import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmitFunction } from '$app/forms';

// Kit's enhance stands in: it hands back the submit function it was given.
let given: SubmitFunction | null = null;
vi.mock('$app/forms', () => ({ enhance: (_form: unknown, submit: SubmitFunction) => ((given = submit), { destroy() {} }) }));
const { enhance } = await import('./forms');

/** Submits once from `page` to `action`; returns what update() was called with. */
async function submitFrom(page: string, action: string, submit?: SubmitFunction) {
	vi.stubGlobal('location', new URL(page));
	enhance({} as HTMLFormElement, submit);
	const input = { action: new URL(action, page), cancel() {}, controller: new AbortController(), formData: new FormData(), formElement: {} as HTMLFormElement, submitter: null };
	const callback = await given!(input);
	const calls: unknown[] = [];
	const update = async (opts?: unknown) => void calls.push(opts);
	if (callback) await callback({ ...input, result: { type: 'success', status: 200 }, update } as never);
	return { callback, calls };
}

beforeEach(() => vi.unstubAllGlobals());

describe('enhance', () => {
	it('keeps a form posting to its own page on that page, query and all', async () => {
		const { calls } = await submitFrom('http://x/instances/a/files?path=config', '?/upload');
		expect(calls).toEqual([{ navigate: false }]);
	});

	it("passes navigate: false through a form's own callback, keeping its options", async () => {
		const { calls } = await submitFrom('http://x/settings?tab=java', '?/snapshots', () => async ({ update }) => update({ reset: false }));
		expect(calls).toEqual([{ navigate: false, reset: false }]);
	});

	it('leaves forms posting to another page as they were', async () => {
		const own = async () => {};
		const { callback } = await submitFrom('http://x/instances/a/mods', '/instances/a?/power', () => own);
		expect(callback).toBe(own);
	});
});
