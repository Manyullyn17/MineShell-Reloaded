import { deserialize, type ActionResult } from '$app/forms';

/**
 * A start refused for memory (lib/server/memoryguard.ts) answers with
 * `memoryWarning`. This asks whether to start anyway and, if so, posts the
 * start again with `force`; the result replaces the refusal. Null when the
 * person said no, or the result was not that refusal.
 */
export async function startAnyway(result: ActionResult, action: URL): Promise<ActionResult | null> {
	if (result.type !== 'failure' || !(result.data as { memoryWarning?: boolean } | undefined)?.memoryWarning) return null;
	if (!confirm(`${(result.data as { message: string }).message}\n\nStart anyway?`)) return null;
	const body = new FormData();
	body.set('verb', 'start');
	body.set('force', 'on');
	const response = await fetch(action, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
	return deserialize(await response.text());
}
