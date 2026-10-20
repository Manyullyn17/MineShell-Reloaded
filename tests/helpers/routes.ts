import { isHttpError, isRedirect } from '@sveltejs/kit';
import { FULL_ACCESS, type Access } from '#lib/shared/access.js';

/**
 * Calling a page's form actions and loads directly, with the parts of a
 * RequestEvent they read:
 *
 *   const result = await post(actions.save, { params: { id }, fields: { motd: 'Hi' } });
 *   expect(await post(actions.save, { params: { id }, access: viewer })).toEqual({ refused: 403 });
 *
 * The access policy (hooks) is not in the way here: what this reaches is the
 * handler itself, with `locals.access` as given (the owner's by default), which
 * is what the checks left to handlers (`requireAccess`) read.
 */
export type RouteEvent = {
	params?: Record<string, string | undefined>;
	/** Form fields (a File for an upload); an array posts the field once per value. */
	fields?: Record<string, string | File | (string | File)[]>;
	access?: Access;
	user?: unknown;
	/** What `cookies.get` answers, for any name. */
	cookie?: string;
	url?: string;
};

/** What an action returned, or `{ refused: status }` for an `error()`, `{ redirect: location }` for a `redirect()`. */
export async function post(action: unknown, event: RouteEvent = {}): Promise<unknown> {
	const form = new FormData();
	for (const [key, value] of Object.entries(event.fields ?? {})) {
		for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
	}
	const url = event.url ?? 'http://localhost/';
	return settle(() =>
		(action as (e: never) => unknown)({
			...base(event, url),
			request: new Request(url, { method: 'POST', body: form })
		} as never)
	);
}

/** A page's load result, with `error()` and `redirect()` answered as in post(). */
export async function load(module: { load?: unknown }, event: RouteEvent = {}): Promise<Record<string, unknown>> {
	const url = event.url ?? 'http://localhost/';
	return (await settle(() => (module.load as (e: never) => unknown)(base(event, url) as never))) as Record<string, unknown>;
}

function base(event: RouteEvent, url: string) {
	return {
		params: event.params ?? {},
		url: new URL(url),
		locals: { authenticated: true, access: event.access ?? FULL_ACCESS, user: event.user ?? null },
		cookies: { get: () => event.cookie }
	};
}

async function settle(run: () => unknown): Promise<unknown> {
	try {
		return await run();
	} catch (err) {
		if (isHttpError(err)) return { refused: err.status };
		if (isRedirect(err)) return { redirect: err.location };
		throw err;
	}
}
