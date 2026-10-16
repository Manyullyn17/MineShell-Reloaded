import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	DATA_DIR,
	INSTANCES_DIR,
	TEMPLATE_UNIT,
	UNITS_DIR,
	systemdUnitDir
} from '#lib/server/config.js';
import { curseforgeKeySource, curseforgeKeyValid, setCurseforgeApiKey } from '#lib/server/curseforge.js';
import {
	AGENT_UNIT,
	agentPage,
	cancelLink,
	DASHBOARD,
	claimState,
	linkedAgent,
	otherTunnels,
	playitLocations,
	playitStatus,
	PlayitError,
	publicAddress,
	serverTunnel,
	setRouting,
	startLink,
	unlink
} from '#lib/server/playit.js';
import {
	installTemplateUnit,
	probeSystemd,
	renderTemplateUnit,
	SERVER_SLICE,
	templateUnitInstalled,
	unitState
} from '#lib/server/systemd.js';
import { applyServerCap, capProblem, getServerCap, inServerSlice, maxCpuPercent, MIN_CAP_MEMORY_MB, saveServerCap, totalMemoryMb } from '#lib/server/servercap.js';
import { runningCeilings } from '#lib/server/memoryguard.js';
import { freePortFor, MOVABLE, portOverview, setServerPort, type PortKind } from '#lib/server/portmap.js';
import {
	addManualJava,
	getJavaDefaults,
	javasRefusing,
	listJavaRuntimes,
	removeJavaRuntime,
	requiredJavaMajor,
	resolveJava,
	runtimeForMajor,
	scanJavaRuntimes,
	setJavaDefault
} from '#lib/server/java.js';
import {
	isJavaVendor,
	isManagedJava,
	JAVA_VENDORS,
	OFFERED_MAJORS,
	removeManagedJava,
	startJavaDownload
} from '#lib/server/javadownload.js';
import { authEnabled } from '#lib/server/auth.js';
import { db } from '#lib/server/db/index.js';
import { auditLog, serverInstances } from '#lib/server/db/schema.js';
import { desc } from 'drizzle-orm';
import { audit, getInstance, InstanceError, listInstances, syncUnit } from '#lib/server/instances.js';
import {
	freeSpace,
	getSnapshotPolicy,
	policyFromForm,
	saveSnapshotPolicy,
	serverSnapshotOverrides,
	snapshotUsage
} from '#lib/server/snapshots.js';
import {
	availableUpdate,
	autoCheckEnabled,
	checkForUpdate,
	currentVersion,
	installInfo,
	lastCheck,
	setAutoCheck,
	startUpdate,
	UpdateRefused,
	updateBlocker,
	updateRunState,
	UPDATE_REPO
} from '#lib/server/selfupdate.js';
import { policyFormValues } from '#lib/shared/snapshots.js';
import { itemIconsEnabled, setItemIcons } from '#lib/server/itemicons.js';
import { MAX_TRASH_DAYS, setTrashDays, trashDays } from '#lib/server/trash.js';
import { allowedAddresses, recentRefusals } from '#lib/server/downloadaccess.js';
import { getSftpSettings, saveSftpSettings, sftpDefaults, validHost, validPort, validUser } from '#lib/server/sftp.js';
import { deleteCustomPreset, getPreset, listPresets, saveCustomPreset, updateCustomPreset } from '#lib/server/jvm-presets.js';
import { BUILT_IN_DEFAULTS, getInstanceDefaults, setInstanceDefaults } from '#lib/server/instance-defaults.js';
import { globalTarget, removeGlobalTarget, saveGlobalTarget, sendTest, targetView } from '#lib/server/notifications.js';
import { NOTIFICATION_KINDS, type NotificationKind, type TargetType } from '#lib/shared/notifications.js';

/**
 * The agent, and each server's tunnel next to the ones made on playit's
 * dashboard. Those others are the owner's account's, so only the owner sees them.
 */
async function playitOverview(owner: boolean) {
	const status = await playitStatus();
	return {
		running: status.running,
		error: status.error,
		problem: status.problem,
		premium: status.premium,
		accountStatus: status.accountStatus,
		servers: listInstances()
			.filter((i) => serverTunnel(i.id))
			.map((i) => ({ id: i.id, name: i.name, port: i.serverPort, ...publicAddress(i.id, status) })),
		others: (owner ? otherTunnels(status) : []).map((t) => ({
			id: t.id,
			name: t.name,
			address: t.display_address,
			localPort: t.localPort,
			server: listInstances().find((i) => i.serverPort === t.localPort)?.name ?? null
		}))
	};
}

/**
 * The cap on all servers together, and each running server's ceiling (heap
 * plus what Java needs beyond it, or its own limit) to hold against it.
 * A running server outside the slice (an older systemd's default) is under
 * the cap only from its next start.
 */
async function serverCapView() {
	const states = await Promise.all(listInstances().map(async (instance) => ({ instance, state: await unitState(instance.id) })));
	const ceilings = await runningCeilings(states.map((s) => ({ instance: s.instance, mainPid: s.state.mainPid || null })));
	return {
		...getServerCap(),
		slice: SERVER_SLICE,
		totalMemoryMb: totalMemoryMb(),
		maxCpu: maxCpuPercent(),
		minMemoryMb: MIN_CAP_MEMORY_MB,
		running: ceilings.map((c) => ({
			id: c.instance.id,
			name: c.instance.name,
			ceilingMb: c.ceilingMb,
			underCap: inServerSlice(states.find((s) => s.instance.id === c.instance.id)!.state.controlGroup)
		}))
	};
}

/** The kinds ticked on a notification form. */
function kindsFrom(form: FormData): NotificationKind[] {
	const known = new Set(NOTIFICATION_KINDS.map((k) => k.kind));
	return form.getAll('kinds').map(String).filter((k): k is NotificationKind => known.has(k as NotificationKind));
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const systemd = await probeSystemd();
	return {
		paths: {
			data: DATA_DIR,
			instances: INSTANCES_DIR,
			units: UNITS_DIR,
			unitDir: systemdUnitDir(),
			templateUnit: TEMPLATE_UNIT
		},
		systemd: { ...systemd, unitInstalled: await templateUnitInstalled() },
		serverCap: await serverCapView(),
		// Streamed, and only on its tab: it reads every process's sockets.
		ports: url.searchParams.get('tab') === 'ports' ? portOverview() : null,
		unitPreview: renderTemplateUnit().replace('${MS_RESTART_POLICY}', 'on-failure'),
		javaRuntimes: javaRuntimeRows(),
		/** MineShell's notification destination, without its address. */
		notifications: targetView('global', globalTarget()),
		javaDownloads: javaDownloads(),
		/** Saved JVM flag presets; the built-in ones are not edited. */
		jvmPresets: listPresets().filter((p) => !p.builtIn),
		/** The preset new servers get (New server defaults). */
		defaultPresetId: getInstanceDefaults().jvmPreset,
		authEnabled: authEnabled(),
		username: locals.user?.username ?? null,
		curseforge: { source: curseforgeKeySource(), valid: curseforgeKeyValid() },
		// Managing the playit.gg link (the account's pages, linking, routing) is the owner's;
		// global admins see whether it works.
		playit: {
			owner: locals.access.owner,
			linked: linkedAgent().agentId !== null,
			dashboard: locals.access.owner ? DASHBOARD : null,
			agentPage: locals.access.owner && linkedAgent().agentId ? agentPage(linkedAgent().agentId!) : null,
			routing: linkedAgent().routing,
			// Streamed: playit's list of locations.
			locations: locals.access.owner && linkedAgent().agentId ? playitLocations() : null,
			claim: locals.access.owner && claimState() ? { ...claimState()! } : null,
			unit: AGENT_UNIT,
			// Streamed: it asks playit's API.
			status: linkedAgent().agentId ? playitOverview(locals.access.owner) : null
		},
		snapshots: policyFormValues(getSnapshotPolicy()),
		snapshotUsage: await Promise.all(
			listInstances().map(async (i) => ({
				id: i.id,
				name: i.name,
				usage: await snapshotUsage(i.path),
				ownSettings: Object.keys(serverSnapshotOverrides(i.id)).length > 0
			}))
		),
		freeBytes: await freeSpace(INSTANCES_DIR),
		recent: db.select().from(auditLog).orderBy(desc(auditLog.timestamp)).limit(40).all(),
		itemIcons: itemIconsEnabled(),
		trash: { days: trashDays(), max: MAX_TRASH_DAYS },
		downloads: { allowed: allowedAddresses(), refused: recentRefusals() },
		sftp: { ...getSftpSettings(), defaults: await sftpDefaults() },
		update: {
			current: currentVersion(),
			installed: installInfo() !== null,
			repo: UPDATE_REPO,
			autoCheck: autoCheckEnabled(),
			check: lastCheck(),
			available: availableUpdate(),
			run: await updateRunState(),
			blocker: updateBlocker()
		}
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

/**
 * The installed Java versions a preset's flags do not start on. A preset is
 * saved either way (one for newer Java is fine to have); applying it checks
 * again against the server's own Java.
 */
async function refusalNote(flags: string): Promise<string> {
	const refused = await javasRefusing(flags);
	return refused.map((r) => ` Java ${r.major} does not start with it: ${r.error}`).join('');
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
		const { fields, error } = policyFromForm(await request.formData());
		if (error) return fail(400, { ok: false, message: error });
		saveSnapshotPolicy(fields);
		return { ok: true, message: 'Snapshot settings saved. They apply from the next snapshot on.' };
	},

	installUnit: async () => {
		const result = await installTemplateUnit();
		if (!result.ok) return fail(500, { ok: false, message: result.message });
		await applyServerCap().catch(() => undefined);

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

	/** Also posted to by a server's Settings ("Save current flags as a preset"): presets belong to every server. */
	savePreset: async ({ request }) => {
		const form = await request.formData();
		try {
			const preset = saveCustomPreset(
				String(form.get('presetName') ?? ''),
				String(form.get('jvmArgs') ?? ''),
				String(form.get('presetDescription') ?? '')
			);
			return { ok: true, message: `Saved "${preset.name}". It is available on every server.${await refusalNote(preset.flags)}` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not save that preset.' });
		}
	},

	updatePreset: async ({ request }) => {
		const form = await request.formData();
		try {
			const preset = updateCustomPreset(String(form.get('presetId') ?? ''), {
				name: String(form.get('presetName') ?? ''),
				description: String(form.get('presetDescription') ?? ''),
				flags: String(form.get('jvmArgs') ?? '')
			});
			return {
				ok: true,
				message: `Saved "${preset.name}". Servers that applied it keep their flags until it is applied again.${await refusalNote(preset.flags)}`
			};
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not save that preset.' });
		}
	},

	deletePreset: async ({ request }) => {
		const id = String((await request.formData()).get('presetId') ?? '');
		const defaults = getInstanceDefaults();
		deleteCustomPreset(id);
		// New servers would quietly have fallen back to the built-in default.
		if (defaults.jvmPreset !== id) return { ok: true, message: 'Preset removed. Servers using it keep their current flags.' };
		const fallback = getPreset(BUILT_IN_DEFAULTS.jvmPreset)!;
		setInstanceDefaults({ ...defaults, jvmPreset: fallback.id });
		return {
			ok: true,
			message: `Preset removed. Servers using it keep their current flags. New servers got it; they get ${fallback.name} now (New server defaults).`
		};
	},

	curseforgeKey: async ({ request }) => {
		const apiKey = String((await request.formData()).get('apiKey') ?? '');
		if (!apiKey) return fail(400, { ok: false, message: 'Enter a key, or use "Remove" to clear it.' });
		const result = await setCurseforgeApiKey(apiKey);
		return { ok: result.ok, message: result.message };
	},

	playitLink: async () => {
		try {
			startLink();
			return { ok: true, message: 'Open the link and approve MineShell on playit.gg.' };
		} catch (err) {
			if (err instanceof PlayitError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
	},

	playitRouting: async ({ request }) => {
		try {
			await setRouting(String((await request.formData()).get('routing') ?? 'Automatic'));
		} catch (err) {
			if (err instanceof PlayitError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'Saved. The agent moves over by itself within a few seconds.' };
	},

	playitCancel: async () => {
		cancelLink();
		return { ok: true, message: 'Linking cancelled.' };
	},

	playitUnlink: async () => {
		await unlink();
		return {
			ok: true,
			message: "Unlinked: MineShell's tunnels are deleted and the agent is stopped. The agent stays listed on playit.gg until you remove it there."
		};
	},

	removeCurseforgeKey: async () => {
		const result = await setCurseforgeApiKey('');
		return { ok: result.ok, message: result.message };
	},

	serverCap: async ({ request }) => {
		const form = await request.formData();
		const optional = (key: string) => {
			const raw = String(form.get(key) ?? '').trim();
			return raw ? Number(raw) : null;
		};
		const cap = { memoryMb: optional('capMemoryMb'), cpuPercent: optional('capCpuPercent') };
		const problem = capProblem(cap);
		if (problem) return fail(400, { ok: false, message: problem });
		try {
			await applyServerCap(cap);
		} catch (err) {
			return fail(500, { ok: false, message: err instanceof Error ? err.message : 'Could not set the cap.' });
		}
		saveServerCap(cap);
		audit('settings.serverCap', { detail: cap.memoryMb || cap.cpuPercent ? `memory ${cap.memoryMb ?? '-'} MB, CPU ${cap.cpuPercent ?? '-'}%` : 'removed' });
		const installed = await templateUnitInstalled();
		return {
			ok: true,
			message: !installed
				? 'Saved. It applies once the unit file is installed.'
				: cap.memoryMb || cap.cpuPercent
					? 'Cap saved and applied to the running servers.'
					: 'Cap removed.'
		};
	},

	// A port from the Ports tab: the number typed, or the first free one (`free`).
	portChange: async ({ request }) => {
		const form = await request.formData();
		const instance = getInstance(String(form.get('instanceId') ?? ''));
		const kind = String(form.get('kind') ?? '') as PortKind;
		if (!instance) return fail(404, { ok: false, message: 'No server with that name.' });
		if (!MOVABLE.includes(kind)) return fail(400, { ok: false, message: 'That port follows the game port; change the game port instead.' });
		try {
			const port = form.get('free') === 'on' ? await freePortFor(instance, kind) : Number(String(form.get('port') ?? '').trim() || NaN);
			await setServerPort(instance, kind, port);
			const running = (await unitState(instance.id)).active === 'active';
			return { ok: true, message: `${instance.name} now has port ${port}${running ? '; restart it to use it' : ''}.` };
		} catch (err) {
			if (err instanceof InstanceError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
	},

	itemIcons: async ({ request }) => {
		const form = await request.formData();
		setItemIcons(form.get('itemIcons') === 'on');
		return { ok: true, message: 'Saved.' };
	},

	notifications: async ({ request }) => {
		const form = await request.formData();
		const url = String(form.get('url') ?? '').trim();
		const problem = saveGlobalTarget({ type: String(form.get('type')) as TargetType, url: url || null, kinds: kindsFrom(form) });
		if (problem) return fail(400, { ok: false, message: problem });
		audit('settings.notifications');
		return { ok: true, message: 'Saved. Send a test message to see it arrive.' };
	},

	notificationsTest: async () => {
		const target = globalTarget();
		if (!target) return fail(400, { ok: false, message: 'Save a destination first.' });
		const result = await sendTest('global', target, { id: 'mineshell', name: 'MineShell' });
		return result.ok ? { ok: true, message: 'Sent; it should be there now.' } : fail(502, { ok: false, message: result.message });
	},

	notificationsRemove: async () => {
		removeGlobalTarget();
		audit('settings.notifications', { detail: 'removed' });
		return { ok: true, message: 'MineShell no longer sends notifications (servers with their own destination still do).' };
	},

	trashDays: async ({ request }) => {
		const form = await request.formData();
		try {
			setTrashDays(Number(String(form.get('trashDays') ?? '').trim() || NaN));
			return { ok: true, message: 'Saved.' };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not save that.' });
		}
	},

	sftp: async ({ request }) => {
		const form = await request.formData();
		const text = (key: string) => String(form.get(key) ?? '').trim();
		const host = text('sftpHost');
		const user = text('sftpUser');
		const port = text('sftpPort') ? Number(text('sftpPort')) : null;
		if (host && !validHost(host)) return fail(400, { ok: false, message: 'The host is a name or an IP address, nothing else.' });
		if (user && !validUser(user)) return fail(400, { ok: false, message: 'That is not an account name.' });
		if (port !== null && !validPort(port)) return fail(400, { ok: false, message: 'The port is a number from 1 to 65535.' });
		saveSftpSettings({ enabled: form.get('sftpEnabled') === 'on', host: host || null, port, user: user || null });
		return { ok: true, message: 'Saved.' };
	},

	checkUpdate: async () => {
		const result = await checkForUpdate();
		if (result.error) return fail(502, { ok: false, message: `Could not ask GitHub: ${result.error}` });
		const newer = availableUpdate();
		return { ok: true, message: newer ? `MineShell ${newer.version} is available.` : `${currentVersion()} is the newest version.` };
	},

	updateAuto: async ({ request }) => {
		const form = await request.formData();
		setAutoCheck(form.get('autoCheck') === 'on');
		return { ok: true, message: 'Saved.' };
	},

	update: async () => {
		try {
			return { ok: true, updateTask: startUpdate() };
		} catch (err) {
			if (err instanceof UpdateRefused) return fail(409, { ok: false, message: err.message });
			throw err;
		}
	}
};

