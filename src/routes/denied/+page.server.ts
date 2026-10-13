import type { PageServerLoad } from './$types';
import { sameOriginPath } from '#lib/shared/links.js';

/** Where guard.ts sends a browser refused a page: what it asked for, and why. */
export const load: PageServerLoad = ({ url }) => ({
	from: sameOriginPath(url.searchParams.get('from'), url.origin),
	unlisted: url.searchParams.get('unlisted') === '1'
});
