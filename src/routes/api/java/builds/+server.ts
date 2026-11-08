import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isJavaVendor, listJavaBuilds } from '#lib/server/javadownload.js';

/** The download form's build picker, in MineShell settings (Java). */
export const GET: RequestHandler = async ({ url }) => {
	const vendor = url.searchParams.get('vendor');
	const major = Number(url.searchParams.get('major'));
	if (!isJavaVendor(vendor) || !Number.isInteger(major) || major < 8 || major > 99) error(400, 'Pick a vendor and a Java version.');
	try {
		return Response.json({ builds: await listJavaBuilds(vendor, major) });
	} catch (err) {
		// The form still downloads the newest without a list.
		error(502, err instanceof Error ? err.message : 'Build lookup failed.');
	}
};
