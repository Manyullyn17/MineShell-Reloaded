import { fetch as undiciFetch, FormData as UndiciFormData } from 'undici';

/**
 * Every request MineShell makes goes through the undici package's fetch instead of Node's own.
 * The fetch built into Node 22 and 24 (undici 6 and 7, still in 22.23 and 24.22) ends the whole
 * process when a host sends a complete file and closes the connection while the file write
 * holds the stream back (docs/notes/packs-and-mods.md; `tests/tools/fetch-close.mjs` shows it);
 * undici 8.12 does not, and Node 26 ships it. Only `fetch` is replaced, not Request or
 * Response, which SvelteKit builds its own requests and answers from.
 *
 * undici knows its own FormData only: Node's (a separate copy of undici's) went out as the
 * text "[object FormData]", so one is copied over. Node's Headers, Response bodies,
 * URLSearchParams and AbortSignal work as they are (checked on Node 22 and 24).
 *
 * Called from hooks.server.ts, which tests never load: they keep their own guard and recorded
 * answers in place of the global fetch (tests/setup.ts).
 */
export function useUndiciFetch(): void {
	const NodeFormData = globalThis.FormData;
	globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		if (init?.body instanceof NodeFormData) {
			const form = new UndiciFormData();
			for (const [name, value] of init.body) form.append(name, value);
			init = { ...init, body: form as unknown as BodyInit };
		}
		// undici's own Response type differs from the DOM one only in its iterators' types.
		return undiciFetch(input as Parameters<typeof undiciFetch>[0], init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
	}) as typeof fetch;
}
