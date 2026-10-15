import { deserialize, enhance as kitEnhance, type SubmitFunction } from '$app/forms';

/**
 * `enhance` from `$app/forms`, except that a form posting to its own page
 * stays on that page. SvelteKit 3's enhance goes where the submission lands:
 * `action="?/upload"` lands on the path without its query, so the Files
 * browser jumped from `?path=config` to the server's root folder, a save in
 * MineShell settings left `?tab=java`, and the overview lost its `?range=`.
 * Forms posting to another page (the instance header's) still navigate unless
 * they say otherwise, as before.
 */
export function enhance<Success extends Record<string, unknown> | undefined, Failure extends Record<string, unknown> | undefined>(
	form: HTMLFormElement,
	submit?: SubmitFunction<Success, Failure>
): { destroy(): void } {
	return kitEnhance<Success, Failure>(form, async (input) => {
		const callback = await submit?.(input);
		if (input.action.pathname !== location.pathname) return callback;
		return async (opts) => {
			const update: typeof opts.update = (options) => opts.update({ navigate: false, ...options });
			if (callback) await callback({ ...opts, update });
			else await update();
		};
	});
}

/** Posts to a form action as an enhanced form does and returns its decoded result. */
export async function postAction(action: string, body: FormData) {
	const res = await fetch(action, {
		method: 'POST',
		body,
		headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
	});
	return deserialize(await res.text());
}

/** The `message` an action answered with, or `fallback`. */
export const actionMessage = (result: Awaited<ReturnType<typeof postAction>>, fallback: string) =>
	result.type === 'success' || result.type === 'failure'
		? String((result.data as { message?: string } | undefined)?.message ?? fallback)
		: result.type === 'error'
			? (result.error?.message ?? fallback)
			: fallback;
