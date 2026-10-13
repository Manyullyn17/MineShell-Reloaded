import { can, type Access } from '#lib/shared/access.js';
import { POLICY, type Requirement } from './policy';

/** What the guard knows about a request when it decides. */
export type RequestFacts = {
	method: string;
	url: URL;
	routeId: string | null;
	params: Record<string, string>;
	signedIn: boolean;
};

/** `page`: a page's load (a browser looking at it), not an action or an endpoint. */
export type Decision = { allowed: true } | { allowed: false; unlisted: boolean; what: string; page: boolean };

export function meets(requirement: Requirement, access: Access, facts: Pick<RequestFacts, 'params' | 'signedIn'>): boolean {
	if (requirement === 'public') return true;
	if (!facts.signedIn) return false;
	if (requirement === 'signedIn') return true;
	if (requirement === 'create') return access.canCreate;
	if (requirement === 'globalAdmin') return access.globalAdmin;
	if (requirement === 'owner') return access.owner;
	if ('any' in requirement) return requirement.any.some((r) => meets(r, access, facts));
	if ('all' in requirement) return requirement.all.every((r) => meets(r, access, facts));
	if ('base' in requirement) return meets(requirement.base, access, facts);
	const instanceId = facts.params.id;
	if (!instanceId) return false;
	const player = requirement.player === 'uuid' ? facts.params.uuid : requirement.player;
	if (requirement.player === 'uuid' && !player) return false;
	return can(access, instanceId, requirement.instance, player);
}

/** A form action's name, read as SvelteKit reads it: the first `?/name`, else `default`. */
export function actionName(url: URL): string {
	for (const [key] of url.searchParams) if (key.startsWith('/')) return key.slice(1);
	return 'default';
}

/**
 * Whether the request may go on. A route, action or method missing from the
 * policy is refused (`unlisted`), whoever asks.
 */
export function decide(facts: RequestFacts, access: Access): Decision {
	// No route: SvelteKit answers 404 (or a static file).
	if (facts.routeId === null) return { allowed: true };
	const entry = POLICY[facts.routeId];
	const method = facts.method === 'HEAD' ? 'GET' : facts.method;
	let requirement: Requirement | undefined;
	let what: string;
	const page = !!entry && !('methods' in entry) && method === 'GET';
	if (!entry) {
		what = facts.routeId;
	} else if ('methods' in entry) {
		what = `${method} ${facts.routeId}`;
		requirement = entry.methods[method as keyof typeof entry.methods];
	} else if (method === 'GET') {
		what = facts.routeId;
		requirement = entry.load;
	} else if (method === 'POST') {
		const name = actionName(facts.url);
		what = `${facts.routeId}?/${name}`;
		requirement = entry.actions && Object.hasOwn(entry.actions, name) ? entry.actions[name] : undefined;
	} else {
		what = `${method} ${facts.routeId}`;
	}
	if (!requirement) return { allowed: false, unlisted: true, what, page };
	return meets(requirement, access, facts) ? { allowed: true } : { allowed: false, unlisted: false, what, page };
}
