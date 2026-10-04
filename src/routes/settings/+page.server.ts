import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	DATA_DIR,
	INSTANCES_DIR,
	SYSTEMD_SCOPE,
	TEMPLATE_UNIT,
	UNITS_DIR,
	systemdUnitDir
} from '$lib/server/config';
import { curseforgeKeySource, curseforgeKeyValid, setCurseforgeApiKey } from '$lib/server/curseforge';
import {
	installTemplateUnit,
	probeSystemd,
	renderTemplateUnit,
	templateUnitInstalled
} from '$lib/server/systemd';
import {
	addManualJava,
	getJavaDefaults,
	listJavaRuntimes,
	removeJavaRuntime,
	requiredJavaMajor,
	resolveJava,
	runtimeForMajor,
	scanJavaRuntimes,
	setJavaDefault
} from '$lib/server/java';
import {
	isJavaVendor,
	isManagedJava,
	JAVA_VENDORS,
	OFFERED_MAJORS,
	removeManagedJava,
	startJavaDownload
} from '$lib/server/javadownload';
import { authEnabled, destroyAllSessions, setPassword } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { auditLog, serverInstances } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';
import { listInstances, syncUnit } from '$lib/server/instances';
import { getSnapshotPolicy, saveSnapshotPolicy } from '$lib/server/snapshots';

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
		javaRuntimes: javaRuntimeRows(),
		javaDownloads: javaDownloads(),
		authEnabled: authEnabled(),
		curseforge: { source: curseforgeKeySource(), valid: curseforgeKeyValid() },
		snapshots: getSnapshotPolicy(),
		recent: db.select().from(auditLog).orderBy(desc(auditLog.timestamp)).limit(40).all()
	};
};

/**
 * Each runtime, and whether servers matching Java automatically use it for its
 * major (`inUse`), and whether that is because it was set as default.
 */
function javaRuntimeRows() {
	const installed = listJavaRuntimes();
	const defaults = getJavaDefaults();
	return installed.map((j) => {
		const pick = runtimeForMajor(installed, j.majorVersion, defaults);
		return {
			...j,
			managed: isManagedJava(j.path),
			inUse: pick?.runtime.path === j.path,
			isDefault: defaults[j.majorVersion] === j.path,
			siblings: installed.filter((o) => o.majorVersion === j.majorVersion).length
		};
	});
}

/**
 * The majors to offer for download (the built-in list plus whatever an
 * existing server needs), and which servers have no runtime at all.
 */
function javaDownloads() {
	const instances = listInstances();
	const needed = new Set(instances.map((i) => requiredJavaMajor(i.minecraftVersion, i.modloader, i.modloaderVersion)));
	const missing = instances
		.filter((i) => !resolveJava({ ...i, explicitPath: i.javaPath }).path)
		.map((i) => ({ name: i.name, major: requiredJavaMajor(i.minecraftVersion, i.modloader, i.modloaderVersion) }));
	return {
		vendors: JAVA_VENDORS,
		majors: [...new Set([...OFFERED_MAJORS, ...needed])].sort((a, b) => b - a),
		missing
	};
}

export const actions: Actions = {
	downloadJava: async ({ request }) => {
		const form = await request.formData();
		const vendor = form.get('vendor');
		const major = Number(form.get('major'));
		if (!isJavaVendor(vendor)) return fail(400, { ok: false, message: 'Pick Temurin or Zulu.' });
		if (!Number.isInteger(major) || major < 8 || major > 99) return fail(400, { ok: false, message: 'Pick a Java version.' });
		startJavaDownload(vendor, major);
		const label = JAVA_VENDORS.find((v) => v.id === vendor)!.label;
		return { ok: true, message: `Downloading ${label} ${major}. Follow it in Tasks; it shows up here when done.` };
	},

	deleteJava: async ({ request }) => {
		try {
			await removeManagedJava(String((await request.formData()).get('path') ?? ''));
			return { ok: true, message: 'Deleted the runtime.' };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not delete that runtime.' });
		}
	},

	javaDefault: async ({ request }) => {
		const form = await request.formData();
		const major = Number(form.get('major'));
		const binary = String(form.get('path') ?? '');
		const runtime = listJavaRuntimes().find((j) => j.path === binary);
		if (binary && (!runtime || runtime.majorVersion !== major)) {
			return fail(400, { ok: false, message: 'That runtime is no longer in the list. Rescan and try again.' });
		}
		setJavaDefault(major, binary || null);
		// Servers pick up the change on their next start; rewriting the env files
		// now keeps what Settings and the unit files say in step.
		for (const instance of listInstances().filter((i) => !i.javaPath)) {
			await syncUnit(instance).catch(() => undefined);
		}
		return {
			ok: true,
			message: binary
				? `Servers that need Java ${major} now use ${binary} from their next start.`
				: `Servers that need Java ${major} use the newest one installed again.`
		};
	},

	snapshots: async ({ request }) => {
		const form = await request.formData();
		const keep = Number(form.get('keep'));
		const askAboveMb = Number(form.get('askAboveMb'));
		if (!Number.isInteger(keep) || keep < 1 || keep > 50) {
			return fail(400, { ok: false, message: 'Keep between 1 and 50 snapshots per server.' });
		}
		if (!Number.isInteger(askAboveMb) || askAboveMb < -1) {
			return fail(400, { ok: false, message: 'The size to ask above is a whole number of MB, or -1.' });
		}
		saveSnapshotPolicy({ keep, askAboveMb });
		return { ok: true, message: 'Snapshot settings saved.' };
	},

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

	curseforgeKey: async ({ request }) => {
		const apiKey = String((await request.formData()).get('apiKey') ?? '');
		if (!apiKey) return fail(400, { ok: false, message: 'Enter a key, or use "Remove" to clear it.' });
		const result = await setCurseforgeApiKey(apiKey);
		return { ok: result.ok, message: result.message };
	},

	removeCurseforgeKey: async () => {
		const result = await setCurseforgeApiKey('');
		return { ok: result.ok, message: result.message };
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
