import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	CURSEFORGE_API_KEY,
	DATA_DIR,
	INSTANCES_DIR,
	SYSTEMD_SCOPE,
	TEMPLATE_UNIT,
	UNITS_DIR,
	systemdUnitDir
} from '$lib/server/config';
import {
	installTemplateUnit,
	probeSystemd,
	renderTemplateUnit,
	templateUnitInstalled
} from '$lib/server/systemd';
import { addManualJava, listJavaRuntimes, removeJavaRuntime, scanJavaRuntimes } from '$lib/server/java';
import { authEnabled, destroyAllSessions, setPassword } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { auditLog, serverInstances } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';
import { syncUnit } from '$lib/server/instances';

export const load: PageServerLoad = async () => {
	const systemd = await probeSystemd();
	return {
		paths: {
			data: DATA_DIR,
			instances: INSTANCES_DIR,
			units: UNITS_DIR,
			unitDir: systemdUnitDir(),
			templateUnit: TEMPLATE_UNIT
		},
		systemd: { ...systemd, scope: SYSTEMD_SCOPE, unitInstalled: await templateUnitInstalled() },
		unitPreview: renderTemplateUnit().replace('${MS_RESTART_POLICY}', 'on-failure'),
		javaRuntimes: listJavaRuntimes(),
		authEnabled: authEnabled(),
		curseforgeKeySet: Boolean(CURSEFORGE_API_KEY),
		recent: db.select().from(auditLog).orderBy(desc(auditLog.timestamp)).limit(40).all()
	};
};

export const actions: Actions = {
	installUnit: async () => {
		const result = await installTemplateUnit();
		if (!result.ok) return fail(500, { ok: false, message: result.message });

		// Re-render every instance's env file and drop-in so a fresh unit is
		// immediately usable rather than needing each instance saved by hand.
		for (const instance of db.select().from(serverInstances).all()) {
			await syncUnit(instance).catch(() => undefined);
		}
		return { ok: true, message: result.message };
	},

	scanJava: async () => {
		const found = await scanJavaRuntimes();
		return {
			ok: true,
			message: found.length
				? `Found ${found.length} Java runtime${found.length === 1 ? '' : 's'}.`
				: 'No Java runtimes found in the usual locations. Add one by path below.'
		};
	},

	addJava: async ({ request }) => {
		const binary = String((await request.formData()).get('path') ?? '').trim();
		if (!binary) return fail(400, { ok: false, message: 'Enter the path to a java binary.' });
		try {
			const info = await addManualJava(binary);
			return { ok: true, message: `Added Java ${info.majorVersion} (${info.versionString}).` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not probe that path.' });
		}
	},

	removeJava: async ({ request }) => {
		removeJavaRuntime(String((await request.formData()).get('path') ?? ''));
		return { ok: true, message: 'Removed from the list. The file itself is untouched.' };
	},

	password: async ({ request }) => {
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');
		if (password !== confirm) return fail(400, { ok: false, message: 'The two passwords do not match.' });
		try {
			setPassword(password);
			if (form.get('signOutEverywhere') === 'on') destroyAllSessions();
			return { ok: true, message: 'Password updated.' };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not save.' });
		}
	}
};
