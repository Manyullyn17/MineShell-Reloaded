import { describe, expect, it } from 'vitest';
import { POLICY, type EndpointPolicy, type PagePolicy, type Requirement } from './policy';

/**
 * The access policy must name every route, action and method there is, and
 * nothing else. The guard refuses whatever it does not name, so a missing entry
 * is a page nobody can use; this test is what makes that safe to rely on.
 */

const pageServers = import.meta.glob<{ actions?: Record<string, unknown>; load?: unknown }>('/src/routes/**/+page.server.ts', { eager: true });
const pageSources = import.meta.glob<string>('/src/routes/**/+page.server.ts', { eager: true, query: '?raw', import: 'default' });
const pages = import.meta.glob('/src/routes/**/+page.svelte');
const endpoints = import.meta.glob<Record<string, unknown>>('/src/routes/**/+server.ts', { eager: true });

const routeId = (file: string) => file.replace(/^\/src\/routes/, '').replace(/\/\+[^/]+$/, '') || '/';
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'fallback'];

const pageRoutes = new Set([...Object.keys(pages), ...Object.keys(pageServers)].map(routeId));
const endpointRoutes = new Set(Object.keys(endpoints).map(routeId));

const isPage = (entry: PagePolicy | EndpointPolicy | undefined): entry is PagePolicy => !!entry && 'load' in entry;
const isEndpoint = (entry: PagePolicy | EndpointPolicy | undefined): entry is EndpointPolicy => !!entry && 'methods' in entry;

function mentionsInstance(requirement: Requirement): boolean {
	if (typeof requirement === 'string') return false;
	if ('instance' in requirement) return true;
	if ('base' in requirement) return mentionsInstance(requirement.base);
	// Any of several: each must be about the server. All of several: one is enough.
	if ('any' in requirement) return requirement.any.every(mentionsInstance);
	return requirement.all.some(mentionsInstance);
}

function handlerChecked(requirement: Requirement): boolean {
	if (typeof requirement === 'string' || 'instance' in requirement) return false;
	if ('base' in requirement) return true;
	return ('any' in requirement ? requirement.any : requirement.all).some(handlerChecked);
}

/** Every requirement in the table, with where it is. */
function allRequirements(): [string, Requirement][] {
	return Object.entries(POLICY).flatMap(([id, entry]) =>
		isPage(entry)
			? [[`${id} load`, entry.load] as [string, Requirement], ...Object.entries(entry.actions ?? {}).map(([name, r]) => [`${id}?/${name}`, r] as [string, Requirement])]
			: Object.entries(entry.methods).map(([method, r]) => [`${method} ${id}`, r!] as [string, Requirement])
	);
}

describe('the access policy', () => {
	it('has an entry for every route, and none for routes that do not exist', () => {
		const routes = new Set([...pageRoutes, ...endpointRoutes]);
		expect([...routes].filter((id) => !POLICY[id]), 'routes with no entry').toEqual([]);
		expect(Object.keys(POLICY).filter((id) => !routes.has(id)), 'entries for no route').toEqual([]);
		expect([...pageRoutes].filter((id) => endpointRoutes.has(id)), 'a page and an endpoint at once: teach decide() which is which').toEqual([]);
	});

	it("names each page's load and every form action, and only those", () => {
		for (const id of pageRoutes) {
			const entry = POLICY[id];
			expect(isPage(entry), `${id} is a page`).toBe(true);
			if (!isPage(entry)) continue;
			const actions = Object.keys(pageServers[`/src/routes${id === '/' ? '' : id}/+page.server.ts`]?.actions ?? {});
			expect(actions.filter((name) => !entry.actions?.[name]), `${id}: actions with no entry`).toEqual([]);
			expect(Object.keys(entry.actions ?? {}).filter((name) => !actions.includes(name)), `${id}: entries for no action`).toEqual([]);
		}
	});

	it("names every endpoint's methods, and only those", () => {
		for (const [file, module] of Object.entries(endpoints)) {
			const id = routeId(file);
			const entry = POLICY[id];
			expect(isEndpoint(entry), `${id} is an endpoint`).toBe(true);
			if (!isEndpoint(entry)) continue;
			const exported = METHODS.filter((m) => m in module);
			expect(exported.includes('fallback'), `${id}: a fallback handler would need decide() to know it`).toBe(false);
			expect(exported.filter((m) => !(m in entry.methods)), `${id}: methods with no entry`).toEqual([]);
			expect(Object.keys(entry.methods).filter((m) => !exported.includes(m)), `${id}: entries for no method`).toEqual([]);
		}
	});

	it('scopes everything under a server to that server', () => {
		const loose = allRequirements().filter(([where, r]) => where.includes('[id]') && !mentionsInstance(r));
		expect(loose.map(([where]) => where)).toEqual([]);
	});

	it('keeps public access to signing in and setting up', () => {
		const open = allRequirements().filter(([, r]) => r === 'public').map(([where]) => where.split(/[ ?]/)[0]);
		expect(new Set(open)).toEqual(new Set(['/login', '/setup']));
	});

	it('has the handler check what the table leaves to it', () => {
		for (const [id, entry] of Object.entries(POLICY)) {
			if (!isPage(entry)) continue;
			const leftToHandler = Object.entries(entry.actions ?? {}).filter(([, r]) => handlerChecked(r));
			if (!leftToHandler.length) continue;
			const source = pageSources[`/src/routes${id === '/' ? '' : id}/+page.server.ts`] ?? '';
			expect(
				/require(Access|GlobalAdmin)\(|can\(locals\.access|mayManage\(/.test(source),
				`${id} (${leftToHandler.map(([n]) => n).join(', ')}) checks access in the handler`
			).toBe(true);
		}
	});
});
