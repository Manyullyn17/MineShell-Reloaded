import { isHttpError, isRedirect } from '@sveltejs/kit';
import { FULL_ACCESS, type Access } from '#lib/shared/access.js';

/**
 * Calling a page's form actions and loads, and endpoints, directly, with the
 * parts of a RequestEvent they read:
 *
 *   const result = await post(actions.save, { params: { id }, fields: { motd: 'Hi' } });
 *   expect(await post(actions.save, { params: { id }, access: viewer })).toEqual({ refused: 403 });
 *   const res = await call(GET, { params: { id }, url: 'http://localhost/?port=25565' });
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
	/** Cookies by name, read and written (`cookieJar()`); takes the place of `cookie`. */
	cookies?: CookieJar;
	/** Request headers (user-agent, origin, x-forwarded-proto). */
	headers?: Record<string, string>;
	/** What `getClientAddress()` answers. */
	ip?: string;
	url?: string;
};

export type CookieJar = ReturnType<typeof cookieJar>;

/** Cookies a handler can set and delete, for a test to read back from `values`. */
export function cookieJar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		values,
		get: (name: string) => values.get(name),
		set: (name: string, value: string) => void values.set(name, value),
		delete: (name: string) => void values.delete(name)
	};
}

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
			request: new Request(url, { method: 'POST', body: form, headers: event.headers })
		} as never)
	);
}

/** A page's load result, with `error()` and `redirect()` answered as in post(). */
export async function load(module: { load?: unknown }, event: RouteEvent = {}): Promise<Record<string, unknown>> {
	const url = event.url ?? 'http://localhost/';
	return (await settle(() => (module.load as (e: never) => unknown)(base(event, url) as never))) as Record<string, unknown>;
}

/**
 * An endpoint's (`+server.ts`) answer to a request with `method` (GET by
 * default) and a raw `body` or a `json` one. An `error()` comes back as the
 * response Kit makes of it (that status, `{ message }`), a `redirect()` as one
 * with its status and `location`.
 */
export async function call(
	handler: unknown,
	event: RouteEvent & { method?: string; body?: BodyInit; json?: unknown } = {}
): Promise<Response> {
	const url = event.url ?? 'http://localhost/';
	const body = event.json !== undefined ? JSON.stringify(event.json) : event.body;
	const request = new Request(url, { method: event.method ?? 'GET', body, headers: event.headers, duplex: 'half' } as RequestInit);
	try {
		return await (handler as (e: never) => Promise<Response>)({ ...base(event, url), request } as never);
	} catch (err) {
		if (isHttpError(err)) return Response.json(err.body, { status: err.status });
		if (isRedirect(err)) return new Response(null, { status: err.status, headers: { location: err.location } });
		throw err;
	}
}

function base(event: RouteEvent, url: string) {
	return {
		params: event.params ?? {},
		url: new URL(url),
		locals: { authenticated: true, access: event.access ?? FULL_ACCESS, user: event.user ?? null },
		cookies: event.cookies ?? { get: () => event.cookie },
		getClientAddress: () => event.ip ?? '127.0.0.1'
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
