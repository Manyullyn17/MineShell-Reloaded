import crypto from 'node:crypto';
import { error } from '@sveltejs/kit';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { db } from './db';
import { mapTokens } from './db/schema';
import { authEnabled, sessionUser, SESSION_COOKIE } from './auth';
import { loadAccess } from './access';
import { getInstance } from './instances';
import { can, FULL_ACCESS, type Access, type InstancePermission } from '#lib/shared/access.js';
import type { ServerInstance } from './db/schema';

/**
 * The Map tab shows pages MineShell did not write - BlueMap's web app, a map
 * mod's own page - and players without an account put things in them (chat,
 * names some mods let them change, markers). On MineShell's own address their
 * scripts could do whatever the person looking can, so they are served under
 * /maps/<token>/ with a sandbox: an origin of their own, which sends no
 * cookies and reaches nothing of MineShell's. The token in the path says whose
 * view it is and of which server; it ends with the session, the server, or 12
 * hours unused.
 */

const UNUSED_MS = 12 * 60 * 60 * 1000;
/** How stale a token's last use may get before it is written again: tiles come by the hundred. */
const TOUCH_MS = 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The token for this session's view of a server's map, the same one while it is used. Null session: MINESHELL_AUTH=off. */
export function mapToken(sessionId: string | null, instanceId: string): string {
	const now = Date.now();
	db.delete(mapTokens).where(lt(mapTokens.usedAt, now - UNUSED_MS)).run();
	const session = sessionId === null ? isNull(mapTokens.sessionId) : eq(mapTokens.sessionId, sessionId);
	const kept = db.select().from(mapTokens).where(and(session, eq(mapTokens.instanceId, instanceId))).get();
	if (kept) {
		db.update(mapTokens).set({ usedAt: now }).where(eq(mapTokens.token, kept.token)).run();
		return kept.token;
	}
	const token = crypto.randomBytes(32).toString('base64url');
	db.insert(mapTokens).values({ token, sessionId, instanceId, createdAt: now, usedAt: now }).run();
	return token;
}

/** Where a page's map frames load from: the server's sandboxed map content, under this session's token. */
export function mapFrames(instanceId: string, cookies: { get: (name: string) => string | undefined }, locals: App.Locals): { view: string; live: string } {
	const token = mapToken(locals.authRequired ? (cookies.get(SESSION_COOKIE) ?? null) : null, instanceId);
	return { view: `/maps/${token}/view/`, live: `/maps/${token}/live/` };
}

/** What a token gives: its server and the access of its session's account; null once it no longer counts. */
export function mapTokenAccess(token: string): { instanceId: string; access: Access } | null {
	if (!TOKEN.test(token)) return null;
	const row = db.select().from(mapTokens).where(eq(mapTokens.token, token)).get();
	const now = Date.now();
	if (!row || row.usedAt < now - UNUSED_MS) return null;
	let access: Access;
	if (row.sessionId === null) {
		if (authEnabled()) return null;
		access = FULL_ACCESS;
	} else {
		const user = sessionUser(row.sessionId);
		if (!user || user.mustChangePassword) return null;
		access = loadAccess(user);
	}
	if (now - row.usedAt > TOUCH_MS) db.update(mapTokens).set({ usedAt: now }).where(eq(mapTokens.token, token)).run();
	return { instanceId: row.instanceId, access };
}

/** The server a map request is for, refused unless its token allows `permission` there. */
export function mapRequest(token: string, permission: InstancePermission): ServerInstance {
	const viewer = mapTokenAccess(token);
	if (!viewer) error(403, 'This map view has ended: reload the Map tab.');
	if (!can(viewer.access, viewer.instanceId, permission)) error(403, 'Your account may not do that on this map.');
	const instance = getInstance(viewer.instanceId);
	if (!instance) error(404, 'No server with that name.');
	return instance;
}

/**
 * Headers for everything under /maps/. The sandbox keeps the page off
 * MineShell's origin even when opened on its own; CORS lets it load its own
 * files from there (module scripts, fetches, WebGL textures); no referrer, so
 * the token does not travel to other sites.
 */
export const MAP_HEADERS: Record<string, string> = {
	'content-security-policy': "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'",
	'access-control-allow-origin': '*',
	'referrer-policy': 'no-referrer',
	'x-content-type-options': 'nosniff'
};

/**
 * The answer to a browser's CORS preflight. Dynmap's requests all ask: its
 * jQuery takes the sandboxed page's address for its own and adds
 * X-Requested-With, and its web chat posts JSON. Whatever headers are asked
 * for are allowed: no credentials go with these requests, the token is the check.
 */
export function mapPreflight(request: Request): Response {
	const asked = (request.headers.get('access-control-request-headers') ?? '').replace(/[^A-Za-z0-9_, -]/g, '');
	return new Response(null, {
		status: 204,
		headers: {
			...MAP_HEADERS,
			'access-control-allow-methods': 'GET, POST',
			...(asked ? { 'access-control-allow-headers': asked } : {}),
			'access-control-max-age': '600'
		}
	});
}

/**
 * Run first in every map page: a sandboxed page may not use localStorage or
 * cookies, and BlueMap and Dynmap do. These keep them in memory, start from
 * what the Map tab saved (passed in the frame's name) and hand every change
 * back to it (MapFrame.svelte) to keep for the next visit.
 */
const SHIM = `(() => {
	const PREFIX = 'mineshell-map:';
	const tell = (message) => parent.postMessage({ mineshellMap: message }, '*');
	let saved = {};
	try {
		if (window.name.startsWith(PREFIX)) saved = JSON.parse(window.name.slice(PREFIX.length));
	} catch {}
	const data = new Map(Object.entries(saved).filter(([, v]) => typeof v === 'string'));
	const save = () => tell({ storage: Object.fromEntries(data) });
	const storage = {
		getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
		setItem: (k, v) => { data.set(String(k), String(v)); save(); },
		removeItem: (k) => { data.delete(String(k)); save(); },
		clear: () => { data.clear(); save(); },
		key: (i) => [...data.keys()][i] ?? null,
		get length() { return data.size; }
	};
	try { window.localStorage; } catch { Object.defineProperty(window, 'localStorage', { value: storage, configurable: true }); }
	const jar = new Map();
	try { document.cookie; } catch {
		Object.defineProperty(document, 'cookie', {
			configurable: true,
			get: () => [...jar].map(([k, v]) => k + '=' + v).join('; '),
			set: (text) => {
				const [pair, ...attributes] = String(text).split(';');
				const at = pair.indexOf('=');
				const name = pair.slice(0, at).trim();
				const expires = attributes.find((a) => /^\\s*expires=/i.test(a));
				if (expires && Date.parse(expires.slice(expires.indexOf('=') + 1)) < Date.now()) jar.delete(name);
				else jar.set(name, pair.slice(at + 1).trim());
			}
		});
	}
})();`;

/** A map page with the shim as its first script. */
export function withShim(html: string): string {
	const script = `<script>${SHIM}</script>`;
	const head = html.match(/<head(\s[^>]*)?>/i);
	return head ? html.replace(head[0], `${head[0]}${script}`) : `${script}${html}`;
}
