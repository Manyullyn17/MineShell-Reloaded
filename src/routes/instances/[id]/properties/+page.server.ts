import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** server.properties moved into Settings; old links and bookmarks land there. */
export const load: PageServerLoad = ({ params }) => {
	redirect(308, `/instances/${params.id}/settings?tab=gameplay`);
};
