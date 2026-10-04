import { fail } from '@sveltejs/kit';
import { cpus } from 'node:os';
import type { Actions, PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { serverInstances, type ServerInstance } from '$lib/server/db/schema';
import { consoleFromForm, restartsFromForm, type RestartSettings } from '$lib/server/instance-defaults';
import {
	InstanceError,
	JavaMissingError,
	changeLoaderVersion,
	migrateToCleanroom,
	readForgeBackup,
	requireInstance,
	revertToForge,
	rconPassword,
	summarise,
	syncPortsToProperties,
	syncUnit
} from '$lib/server/instances';
import { applyCleanroomModFixes, cleanroomReport } from '$lib/server/cleanroom';
import { applyPackChange } from '$lib/server/packchange';
import {
	decideSnapshot,
	getSnapshotPolicy,
	policyFromForm,
	saveServerSnapshotOverrides,
	serverSnapshotOverrides,
	SnapshotChoiceNeeded,
	snapshotPrompt,
	snapshotUsage
} from '$lib/server/snapshots';
import { policyFormValues } from '$lib/shared/snapshots';
import { isJavaVendor } from '$lib/server/javadownload';
import {
	addScheduledCommand,
	cleanCommand,
	listScheduledCommands,
	removeScheduledCommand,
	setScheduledCommandEnabled
} from '$lib/server/scheduledcommands';
import { canUseCleanroom } from '$lib/shared/cleanroom';
import { listJavaRuntimes, resolveJava, requiredJavaMajor, scanJavaRuntimes } from '$lib/server/java';
import { portConflict } from '$lib/server/ports';
import { rescheduleInstance } from '$lib/server/scheduler';
import { encryptSecret, randomPassword } from '$lib/server/crypto';
import { LOADER_LIST, getLoader, listReleaseVersions } from '$lib/server/modloaders';
import {
	composeJvmArgs,
	deleteCustomPreset,
	getPreset,
	listPresets,
	saveCustomPreset,
	stripMemoryFlags
} from '$lib/server/jvm-presets';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const cleanroomRelevant =
		instance.modloader === 'cleanroom' || canUseCleanroom(instance.modloader, instance.minecraftVersion);
	const backup = cleanroomRelevant ? await readForgeBackup(instance) : null;
	const running = (await summarise(instance)).running;
	const java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader,
		modloaderVersion: instance.modloaderVersion
	});

	// Version pickers, so these are not free-text fields where a typo silently
	// mislabels the instance. Both lists are best-effort: if the metadata
	// servers are unreachable the page falls back to a text input.
	const [minecraftVersions, loaderVersions] = await Promise.all([
		listReleaseVersions().catch(() => [] as string[]),
		getLoader(instance.modloader)
			.listLoaderVersions(instance.minecraftVersion)
			.catch(() => [] as string[])
	]);

	return {
		minecraftVersions,
		loaderVersions,
		jvmPresets: listPresets(),
		settings: {
			name: instance.name,
			minecraftVersion: instance.minecraftVersion,
			modloader: instance.modloader,
			modloaderVersion: instance.modloaderVersion,
			jvmArgs: instance.jvmArgs,
			launchArgs: instance.launchArgs,
			memoryMinMb: instance.memoryMinMb,
			memoryMaxMb: instance.memoryMaxMb,
			javaPath: instance.javaPath,
			serverPort: instance.serverPort,
			rconPort: instance.rconPort,
			restartSchedule: instance.restartSchedule,
			restartIntervalHours: instance.restartIntervalHours,
			restartDailyTime: instance.restartDailyTime,
			restartWarnMinutes: instance.restartWarnMinutes,
			restartSkipIfPlayers: instance.restartSkipIfPlayers,
			autoRestartOnCrash: instance.autoRestartOnCrash,
			crashRestartLimit: instance.crashRestartLimit,
			crashRestartWindowSec: instance.crashRestartWindowSec,
			consoleBacklogLines: instance.consoleBacklogLines,
			consoleBufferLines: instance.consoleBufferLines,
			limitMemoryMb: instance.limitMemoryMb,
			limitCpuPercent: instance.limitCpuPercent
		},
		cpuCores: cpus().length || 1,
		rconPassword: rconPassword(instance),
		javaRuntimes: listJavaRuntimes(),
		requiredJava: requiredJavaMajor(instance.minecraftVersion, instance.modloader, instance.modloaderVersion),
		javaResolution: java,
		// What "Match automatically" would pick, which differs from `java` when a path is pinned.
		autoJava: instance.javaPath ? resolveJava({ ...instance, explicitPath: null }) : java,
		loaders: LOADER_LIST.map((l) => ({ id: l.id, label: l.label })),
		running,
		pack:
			instance.packSource && instance.packProjectId
				? {
						source: instance.packSource,
						projectId: instance.packProjectId,
						name: instance.packName,
						versionId: instance.packVersionId,
						versionName: instance.packVersionName
					}
				: null,
		cleanroom: cleanroomRelevant
			? {
					onCleanroom: instance.modloader === 'cleanroom',
					backupCreatedAt: backup?.createdAt ?? null,
					running
				}
			: null,
		// Streamed: scanning means opening every mod jar.
		cleanroomReport: cleanroomRelevant ? cleanroomReport(instance.path) : null,
		snapshotPrompt: await snapshotPrompt(instance),
		// The server's own retention settings (blank = global), with the global values as placeholders.
		snapshotSettings: {
			values: policyFormValues(serverSnapshotOverrides(instance.id)),
			global: policyFormValues(getSnapshotPolicy()),
			usage: await snapshotUsage(instance.path)
		},
		scheduledCommands: listScheduledCommands(instance.id)
	};
};

/**
 * Java needs memory beyond its heap (metaspace, threads, native buffers), and
 * systemd kills the server at MemoryMax, so a limit has to leave this much.
 */
const LIMIT_HEADROOM_MB = 512;

/**
 * A refusal the person can act on: shown on the form instead of as an error
 * page. A missing Java names the form (`action`), which then offers to
 * download it and submit again.
 */
function refused(err: unknown, action?: string) {
	if (err instanceof JavaMissingError && action) {
		return fail(400, { ok: false, message: err.message, javaMissing: { major: err.major, action } });
	}
	if (err instanceof InstanceError || err instanceof SnapshotChoiceNeeded) return fail(400, { ok: false, message: err.message });
	return null;
}

function downloadJavaFrom(form: FormData) {
	const vendor = form.get('downloadJava');
	return isJavaVendor(vendor) ? vendor : undefined;
}

/** The instance's current values, which a missing or unusable field keeps. */
function restartSettingsOf(instance: ServerInstance): RestartSettings {
	return {
		restartSchedule: instance.restartSchedule,
		restartIntervalHours: instance.restartIntervalHours ?? 6,
		restartDailyTime: instance.restartDailyTime ?? '05:00',
		restartWarnMinutes: instance.restartWarnMinutes,
		restartSkipIfPlayers: instance.restartSkipIfPlayers,
		autoRestartOnCrash: instance.autoRestartOnCrash,
		crashRestartLimit: instance.crashRestartLimit,
		crashRestartWindowSec: instance.crashRestartWindowSec
	};
}

function int(form: FormData, key: string, fallback: number): number {
	const value = Number(form.get(key));
	return Number.isFinite(value) ? Math.round(value) : fallback;
}

export const actions: Actions = {
	general: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { ok: false, message: 'The server needs a name.' });

		const minecraftVersion = String(
			form.get('minecraftVersion') ?? instance.minecraftVersion
		).trim();

		db.update(serverInstances)
			.set({ name, minecraftVersion, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();

		// The Minecraft version only relabels the instance - nothing here swaps
		// the server jar - so say so plainly. The loader version has its own
		// action below that really reinstalls.
		return {
			ok: true,
			message:
				minecraftVersion !== instance.minecraftVersion
					? 'Saved. Note this only updates the recorded Minecraft version - the installed server files are unchanged.'
					: 'Saved.'
		};
	},

	changePack: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const versionId = String(form.get('versionId') ?? '').trim();
		if (!versionId) return fail(400, { ok: false, message: 'Pick a pack version first.' });
		try {
			await applyPackChange(instance, versionId, {
				updateMods: form.getAll('updateMod').map(String),
				confirmMinecraftChange: form.get('confirmMinecraft') === 'on',
				snapshot: await decideSnapshot(instance, form.get('snapshot')),
				downloadJava: downloadJavaFrom(form)
			});
			return {
				ok: true,
				message: 'Changing the pack version. Follow it in Tasks; the server stays stopped until it finishes.'
			};
		} catch (err) {
			return refused(err, 'changePack') ?? fail(502, { ok: false, message: err instanceof Error ? err.message : 'Could not change the pack version.' });
		}
	},

	loaderVersion: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const version = String(form.get('modloaderVersion') ?? '').trim() || null;
		if (version && version === instance.modloaderVersion) {
			return fail(400, { ok: false, message: `${version} is already installed.` });
		}
		try {
			await changeLoaderVersion(instance, version, {
				snapshot: await decideSnapshot(instance, form.get('snapshot')),
				downloadJava: downloadJavaFrom(form)
			});
			return { ok: true, message: 'Reinstalling the loader. Follow it in Tasks; the server stays stopped until it finishes.' };
		} catch (err) {
			const failure = refused(err, 'loaderVersion');
			if (failure) return failure;
			throw err;
		}
	},

	runtime: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();

		const maxMb = int(form, 'memoryMaxMb', instance.memoryMaxMb ?? 4096);
		const minMb = int(form, 'memoryMinMb', instance.memoryMinMb ?? 1024);
		if (minMb > maxMb) {
			return fail(400, { ok: false, message: 'Starting memory cannot exceed the maximum.' });
		}
		if (instance.limitMemoryMb && maxMb + LIMIT_HEADROOM_MB > instance.limitMemoryMb) {
			return fail(400, {
				ok: false,
				message: `The memory limit below is ${instance.limitMemoryMb} MB; raise it first, or Java would be killed past it.`
			});
		}

		// Applying a preset replaces the flag body; otherwise the textarea wins.
		// Either way the memory flags are rebuilt from the memory fields, so the
		// two can never drift apart.
		const presetId = String(form.get('applyPreset') ?? '').trim();
		const preset = presetId ? getPreset(presetId) : null;
		if (presetId && !preset) {
			return fail(400, { ok: false, message: 'That preset no longer exists.' });
		}

		const body = preset
			? preset.flags
			: stripMemoryFlags(String(form.get('jvmArgs') ?? instance.jvmArgs));
		const jvmArgs = composeJvmArgs(body, minMb, maxMb);

		db.update(serverInstances)
			.set({
				memoryMaxMb: maxMb,
				memoryMinMb: minMb,
				jvmArgs,
				launchArgs: String(form.get('launchArgs') ?? instance.launchArgs).trim(),
				// The manual path field wins when it says something different, so a
				// runtime that was never scanned can still be used.
				javaPath:
					String(form.get('javaPathManual') ?? '').trim() ||
					String(form.get('javaPath') ?? '').trim() ||
					null,
				updatedAt: Date.now()
			})
			.where(eq(serverInstances.id, instance.id))
			.run();

		const { warning } = await syncUnit(requireInstance(instance.id));
		return {
			ok: true,
			message:
				warning ??
				(preset
					? `Applied the ${preset.name} preset. Restart the server to use it.`
					: 'Saved. Restart the server to apply the new runtime settings.')
		};
	},

	limits: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const optional = (key: string) => {
			const raw = String(form.get(key) ?? '').trim();
			return raw ? Number(raw) : null;
		};
		const memoryMb = optional('limitMemoryMb');
		const cpuPercent = optional('limitCpuPercent');
		const heap = instance.memoryMaxMb ?? 0;
		if (memoryMb !== null && (!Number.isInteger(memoryMb) || memoryMb < heap + LIMIT_HEADROOM_MB)) {
			return fail(400, {
				ok: false,
				message: `The memory limit has to leave Java room above its ${heap} MB heap: at least ${heap + LIMIT_HEADROOM_MB} MB, or blank for none.`
			});
		}
		const maxCpu = (cpus().length || 1) * 100;
		if (cpuPercent !== null && (!Number.isInteger(cpuPercent) || cpuPercent < 10 || cpuPercent > maxCpu)) {
			return fail(400, { ok: false, message: `The CPU limit is between 10 and ${maxCpu} percent, or blank for none.` });
		}
		db.update(serverInstances)
			.set({ limitMemoryMb: memoryMb, limitCpuPercent: cpuPercent, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		await syncUnit(requireInstance(instance.id));
		return { ok: true, message: memoryMb || cpuPercent ? 'Limits saved. Restart the server to apply them.' : 'Limits removed. Restart the server to apply.' };
	},

	savePreset: async ({ request, params }) => {
		requireInstance(params.id);
		const form = await request.formData();
		try {
			const preset = saveCustomPreset(
				String(form.get('presetName') ?? ''),
				String(form.get('jvmArgs') ?? '')
			);
			return { ok: true, message: `Saved "${preset.name}". It is available on every instance.` };
		} catch (err) {
			return fail(400, {
				ok: false,
				message: err instanceof Error ? err.message : 'Could not save that preset.'
			});
		}
	},

	deletePreset: async ({ request, params }) => {
		requireInstance(params.id);
		deleteCustomPreset(String((await request.formData()).get('presetId') ?? ''));
		return { ok: true, message: 'Preset removed. Instances using it keep their current flags.' };
	},

	network: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const serverPort = int(form, 'serverPort', instance.serverPort);
		const rconPort = int(form, 'rconPort', instance.rconPort);

		if (serverPort === rconPort) {
			return fail(400, { ok: false, message: 'The game port and RCON port must differ.' });
		}
		for (const port of [serverPort, rconPort]) {
			const conflict = portConflict(port, instance.id);
			if (conflict) return fail(400, { ok: false, message: conflict });
		}

		const update: Record<string, unknown> = { serverPort, rconPort, updatedAt: Date.now() };
		if (form.get('rotateRcon') === 'on') {
			update.rconPasswordEnc = encryptSecret(randomPassword());
		}

		db.update(serverInstances)
			.set(update)
			.where(eq(serverInstances.id, instance.id))
			.run();

		await syncPortsToProperties(requireInstance(instance.id));
		return { ok: true, message: 'Saved and written to server.properties. Restart to apply.' };
	},

	addCommand: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const command = cleanCommand(String(form.get('command') ?? ''));
		if (!command) return fail(400, { ok: false, message: 'Enter the command to run.' });
		if (command.length > 500) return fail(400, { ok: false, message: 'That command is too long.' });
		if (form.get('mode') === 'daily') {
			const time = String(form.get('dailyTime') ?? '');
			if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return fail(400, { ok: false, message: 'Pick a time of day.' });
			addScheduledCommand(instance.id, command, { dailyTime: time });
		} else {
			const minutes = Number(form.get('everyMinutes'));
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
				return fail(400, { ok: false, message: 'Run it every 1 minute to 7 days.' });
			}
			addScheduledCommand(instance.id, command, { everyMinutes: minutes });
		}
		return { ok: true, message: `Scheduled "${command}". It runs while the server is running.` };
	},

	removeCommand: async ({ request, params }) => {
		removeScheduledCommand(params.id, Number((await request.formData()).get('id')));
		return { ok: true, message: 'Scheduled command removed.' };
	},

	toggleCommand: async ({ request, params }) => {
		const form = await request.formData();
		setScheduledCommandEnabled(params.id, Number(form.get('id')), form.get('enabled') === 'true');
		return { ok: true, message: form.get('enabled') === 'true' ? 'Scheduled command on.' : 'Scheduled command paused.' };
	},

	restarts: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();

		db.update(serverInstances)
			.set({ ...restartsFromForm(form, restartSettingsOf(instance)), updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();

		await syncUnit(requireInstance(instance.id));
		rescheduleInstance(instance.id);
		return { ok: true, message: 'Restart behaviour saved.' };
	},

	console: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		db.update(serverInstances)
			.set({ ...consoleFromForm(form, instance), updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: 'Console preferences saved.' };
	},

	snapshotPolicy: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		if (form.get('useGlobal') === 'on') {
			saveServerSnapshotOverrides(instance.id, {});
			return { ok: true, message: 'This server follows the global snapshot settings again.' };
		}
		const { fields, error } = policyFromForm(form);
		if (error) return fail(400, { ok: false, message: error });
		saveServerSnapshotOverrides(instance.id, fields);
		return { ok: true, message: 'Snapshot settings saved. They apply from the next snapshot on.' };
	},

	migrateCleanroom: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const version = String(form.get('cleanroomVersion') ?? '').trim() || null;
		try {
			await migrateToCleanroom(instance, version, {
				snapshot: await decideSnapshot(instance, form.get('snapshot')),
				downloadJava: downloadJavaFrom(form)
			});
			return { ok: true, message: 'Migration started. Follow it in Tasks; the server stays stopped until it finishes.' };
		} catch (err) {
			const failure = refused(err, 'migrateCleanroom');
			if (failure) return failure;
			throw err;
		}
	},

	revertForge: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await revertToForge(instance, { snapshot: await decideSnapshot(instance, form.get('snapshot')) });
			return { ok: true, message: 'Reverting to Forge. Follow it in Tasks.' };
		} catch (err) {
			const failure = refused(err);
			if (failure) return failure;
			throw err;
		}
	},

	/** Re-run the automatic part of the migration, e.g. after adding mods to a Cleanroom server. */
	cleanroomFixes: async ({ params }) => {
		const instance = requireInstance(params.id);
		if (instance.modloader !== 'cleanroom') {
			return fail(400, { ok: false, message: 'This server is not running Cleanroom.' });
		}
		if ((await summarise(instance)).running) {
			return fail(400, { ok: false, message: 'Stop the server first.' });
		}
		const result = await applyCleanroomModFixes(instance);
		const done = [
			result.disabled.length && `disabled ${result.disabled.length} mod(s)`,
			result.added.length && `added ${result.added.join(', ')}`
		].filter(Boolean);
		return {
			ok: result.failures.length === 0,
			message: [done.length ? `Done: ${done.join('; ')}.` : 'Nothing needed changing.', ...result.failures].join(' ')
		};
	},

	rescanJava: async ({ params }) => {
		requireInstance(params.id);
		const found = await scanJavaRuntimes();
		return { ok: true, message: `Found ${found.length} Java runtime${found.length === 1 ? '' : 's'}.` };
	}
};
