const DATA_SUFFIX = '/__data.json';
const INVALIDATED = 'x-sveltekit-invalidated';

/**
 * What a reload of the page's own data gets when it never got an answer (the connection went, a
 * restart, Firefox ending it at a navigation): Kit's own "nothing changed", so the page stays as
 * it is until the next reload. Without it the request's failure is Kit's 500 page, which no timer
 * comes back from. Null for any other request, a move to another page among them: that one
 * has nothing to stay on, and a real error from the server is an answer and never gets here.
 */
export function unchangedAnswer(requested: string, here: string): Response | null {
	const url = new URL(requested, here);
	const page = new URL(here);
	const invalidated = url.searchParams.get(INVALIDATED);
	if (!invalidated || url.origin !== page.origin || !url.pathname.endsWith(DATA_SUFFIX)) return null;
	url.searchParams.delete(INVALIDATED);
	const pathname = url.pathname.slice(0, -DATA_SUFFIX.length) || '/';
	if (pathname !== page.pathname || url.search !== page.search) return null;
	const nodes = [...invalidated].map(() => ({ type: 'skip' }));
	return new Response(`${JSON.stringify({ type: 'data', nodes })}\n`, { headers: { 'content-type': 'application/x-ndjson' } });
}
