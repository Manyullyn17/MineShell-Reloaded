import { fail, redirect } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cpus } from 'node:os';
import type { Actions, PageServerLoad } from './$types';
import { bootStartNote } from '#lib/server/bootstart.js';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { serverInstances, type ServerInstance } from '#lib/server/db/schema.js';
import { consoleFromForm, restartsFromForm, type RestartSettings } from '#lib/server/instance-defaults.js';
import {
	InstanceError,
	JavaMissingError,
	changeLoaderVersion,
	cloneInstance,
	deleteInstance,
	migrateToCleanroom,
	movePortAside,
	readForgeBackup,
	requireInstance,
	revertToForge,
	rconPassword,
	summarise,
	syncPortsToProperties,
	syncUnit
} from '#lib/server/instances.js';
import { applyCleanroomModFixes, cleanroomReport } from '#lib/server/cleanroom.js';
import { applyPackChange } from '#lib/server/packchange.js';
import { applyMigration } from '#lib/server/migrate.js';
import { latestMergeReport, resolveMerge } from '#lib/server/configmerge.js';
import { markMemoryChanged, memoryAdvice } from '#lib/server/memoryadvice.js';
import { formInt } from '#lib/server/formvalues.js';
import { getSnapshotSchedule, saveSnapshotSchedule, scheduledSnapshotAt, validSchedule } from '#lib/server/snapshotschedule.js';
import {
	decideSnapshot,
	getSnapshotPolicy,
	policyFromForm,
	saveServerSnapshotOverrides,
	serverSnapshotOverrides,
	SnapshotChoiceNeeded,
	snapshotPrompt,
	snapshotUsage
} from '#lib/server/snapshots.js';
import { policyFormValues } from '#lib/shared/snapshots.js';
import { isJavaVendor } from '#lib/server/javadownload.js';
import {
	addScheduledCommand,
	cleanCommand,
	listScheduledCommands,
	removeScheduledCommand,
	setScheduledCommandEnabled
} from '#lib/server/scheduledcommands.js';
import { canUseCleanroom } from '#lib/shared/cleanroom.js';
import { listJavaRuntimes, resolveJava, requiredJavaMajor, scanJavaRuntimes } from '#lib/server/java.js';
import { portConflict } from '#lib/server/ports.js';
import { linkedAgent, makePrivate, makePublic, playitStatus, PlayitError, publicAddress, REGIONS, serverTunnel } from '#lib/server/playit.js';
import { forgetDiskBreakdown } from '#lib/server/diskusage.js';
import {
	PROPERTY_SCHEMA,
	levelTypeOptionsFor,
	parseProperties,
	propertiesFromForm,
	readProperties,
	serialiseProperties,
	writeProperties
} from '#lib/server/properties.js';
import { rescheduleInstance } from '#lib/server/scheduler.js';
import { encryptSecret, randomPassword } from '#lib/server/crypto.js';
import { LOADER_LIST, LOADERS, pickerLoaderVersions, pickerReleaseVersions, type ModloaderId } from '#lib/server/modloaders.js';
import {
	composeJvmArgs,
	deleteCustomPreset,
	getPreset,
	listPresets,
	saveCustomPreset,
	stripMemoryFlags
} from '#lib/server/jvm-presets.js';

/**
 * server.properties keys with a control of their own elsewhere: MineShell
 * owns RCON (the DB holds the password and port), and the game port is set
 * with the RCON port through the network action so the DB and file agree.
 */
const MANAGED_KEYS = new Set(['rcon.password', 'enable-rcon', 'rcon.port', 'server-port']);
const editableProperties = () => PROPERTY_SCHEMA.filter((f) => !MANAGED_KEYS.has(f.key));

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const parsed = await readProperties(instance.path);
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
	// servers are unreachable the page falls back to a text input. Streamed:
	// the first fetch takes up to 0.6 s (Forge's), after that they are kept.
	const versions = Promise.all([
		pickerReleaseVersions().catch(() => [] as string[]),
		pickerLoaderVersions(instance.modloader, instance.minecraftVersion).catch(() => [] as string[])
	]).then(([minecraft, loader]) => ({ minecraft, loader }));

	return {
		versions,
		jvmPresets: listPresets(),
		// Streamed: it may search the journal for an out-of-memory crash.
		memoryAdvice: memoryAdvice(instance).catch(() => null),
		playit: {
			linked: linkedAgent().agentId !== null,
			tunnel: serverTunnel(instance.id),
			regions: REGIONS,
			// Streamed: it asks playit's API.
			status: linkedAgent().agentId
				? playitStatus().then((status) => ({
						address: publicAddress(instance.id, status),
						premium: status.premium,
						running: status.running && !status.problem,
						error: status.error
					}))
				: null
		},
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
			bootStart: instance.bootStart,
			consoleBacklogLines: instance.consoleBacklogLines,
			consoleBufferLines: instance.consoleBufferLines,
			limitMemoryMb: instance.limitMemoryMb,
			limitCpuPercent: instance.limitCpuPercent,
			...(() => {
				const schedule = getSnapshotSchedule(instance.id);
				return {
					snapshotEvery: schedule.every,
					snapshotDailyTime: schedule.dailyTime,
					snapshotIntervalHours: schedule.intervalHours,
					snapshotWhileRunning: schedule.whileRunning,
					snapshotWarnMinutes: schedule.warnMinutes
				};
			})()
		},
		/** When the next scheduled snapshot is due, if one is set. */
		snapshotNextAt: scheduledSnapshotAt(instance.id),
		cpuCores: cpus().length || 1,
		rconPassword: rconPassword(instance),
		javaRuntimes: listJavaRuntimes(),
		requiredJava: requiredJavaMajor(instance.minecraftVersion, instance.modloader, instance.modloaderVersion),
		javaResolution: java,
		// What "Match automatically" would pick, which differs from `java` when a path is pinned.
		autoJava: instance.javaPath ? resolveJava({ ...instance, explicitPath: null }) : java,
		loaders: LOADER_LIST.map((l) => ({ id: l.id, label: l.label })),
		running,
		// An uploaded pack has no project: it is updated by uploading the next version's file.
		pack:
			instance.packSource
				? {
						source: instance.packSource,
						projectId: instance.packProjectId,
						name: instance.packName,
						versionId: instance.packVersionId,
						versionName: instance.packVersionName
					}
				: null,
		/** The last pack change's config merge, for the review under Modpack. */
		configMerge: instance.packSource ? await latestMergeReport(instance.path) : null,
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
		scheduledCommands: listScheduledCommands(instance.id),
		properties: {
			values: parsed.values,
			extras: parsed.extraKeys.filter((k) => !MANAGED_KEYS.has(k)).map((key) => ({ key, value: parsed.values[key] })),
			schema: editableProperties().map((field) =>
				field.key === 'level-type' ? { ...field, options: levelTypeOptionsFor(instance.minecraftVersion) } : field
			),
			raw: serialiseProperties(parsed.values)
		},
		bootNote: bootStartNote(),
		hasIcon: await fs.access(path.join(instance.path, 'server-icon.png')).then(
			() => true,
			() => false
		)
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
		crashRestartWindowSec: instance.crashRestartWindowSec,
		bootStart: instance.bootStart
	};
}

export const actions: Actions = {
	general: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { ok: false, message: 'The server needs a name.' });

		// The Minecraft version is not edited here: it only relabelled the server.
		// `migrate` moves it for real, a pack server moves with its pack.
		db.update(serverInstances)
			.set({ name, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: 'Saved.' };
	},

	/** A config file from the last pack change's merge: the user's side or the pack's. */
	resolveConfig: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const use = form.get('use') === 'mine' ? 'mine' : 'pack';
		const rel = String(form.get('path') ?? '');
		const done = await resolveMerge(instance.path, String(form.get('stamp') ?? ''), rel, use);
		if (!done) return fail(404, { ok: false, message: 'That file is no longer in the merge report.' });
		return { ok: true, message: `${rel}: ${use === 'mine' ? 'your version' : 'the pack’s version'} is in place.` };
	},

	/** To another Minecraft version and/or loader, mods moved along (migrate.ts). */
	migrate: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const minecraft = String(form.get('minecraft') ?? '').trim();
		const loader = String(form.get('loader') ?? '');
		if (!minecraft || !(loader in LOADERS)) return fail(400, { ok: false, message: 'Pick a Minecraft version and a loader.' });
		try {
			await applyMigration(
				instance,
				{ minecraft, loader: loader as ModloaderId, loaderVersion: String(form.get('loaderVersion') ?? '').trim() || null },
				{
					confirmMinecraftChange: form.get('confirmMinecraft') === 'on',
					snapshot: await decideSnapshot(instance, form.get('snapshot')),
					downloadJava: downloadJavaFrom(form)
				}
			);
			return { ok: true, message: 'Moving the server. Follow it in Tasks; it stays stopped until it finishes.' };
		} catch (err) {
			return refused(err, 'migrate') ?? fail(502, { ok: false, message: err instanceof Error ? err.message : 'Could not move the server.' });
		}
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

		const maxMb = formInt(form, 'memoryMaxMb', instance.memoryMaxMb ?? 4096);
		const minMb = formInt(form, 'memoryMinMb', instance.memoryMinMb ?? 1024);
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

		if (maxMb !== instance.memoryMaxMb) markMemoryChanged(instance.id);
		db.update(serverInstances)
			.set({
				memoryMaxMb: maxMb,
				memoryMinMb: minMb,
				jvmArgs,
				launchArgs: String(form.get('launchArgs') ?? instance.launchArgs).trim(),
				// The manual path field wins when it says something different, so a
				// runtime that was never scanned can still be used. A form without
				// either field keeps the current choice.
				javaPath:
					form.has('javaPath') || form.has('javaPathManual')
						? String(form.get('javaPathManual') ?? '').trim() || String(form.get('javaPath') ?? '').trim() || null
						: instance.javaPath,
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
		const serverPort = formInt(form, 'serverPort', instance.serverPort);
		const rconPort = formInt(form, 'rconPort', instance.rconPort);

		if (![serverPort, rconPort].every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
			return fail(400, { ok: false, message: 'Ports go from 1 to 65535.' });
		}
		if (serverPort === rconPort) {
			return fail(400, { ok: false, message: 'The game port and RCON port must differ.' });
		}
		// A port another server has moves that server first, as chosen next to the field.
		const moved: string[] = [];
		const changes = [
			{ port: serverPort, field: 'game' as const, current: instance.serverPort, how: form.get('moveGame') },
			{ port: rconPort, field: 'rcon' as const, current: instance.rconPort, how: form.get('moveRcon') }
		];
		for (const change of changes) {
			if (change.port === change.current) continue;
			const conflict = portConflict(change.port, instance.id);
			if (!conflict) continue;
			if (change.how !== 'swap' && change.how !== 'free') {
				return fail(400, { ok: false, message: `${conflict} Choose next to the field whether to swap ports with it or move it.` });
			}
			try {
				const result = await movePortAside(instance.id, change.port, change.field, change.how);
				if (result) {
					moved.push(
						`${result.name}'s ${result.kind === 'game' ? 'game' : 'RCON'} port is now ${result.to}${result.running ? ' (restart it to apply)' : ''}.`
					);
				}
			} catch (err) {
				if (err instanceof InstanceError) return fail(400, { ok: false, message: err.message });
				throw err;
			}
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
		return { ok: true, message: ['Saved and written to server.properties. Restart to apply.', ...moved].join(' '), notes: moved };
	},

	playitPublic: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const region = String((await request.formData()).get('region') ?? 'global');
		if (!REGIONS.some((r) => r.id === region)) return fail(400, { ok: false, message: 'Unknown region.' });
		try {
			await makePublic(instance, region);
		} catch (err) {
			if (err instanceof PlayitError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'Public through playit.gg. The address shows up here and in the header in a moment.' };
	},

	playitPrivate: async ({ params }) => {
		const instance = requireInstance(params.id);
		try {
			await makePrivate(instance.id);
		} catch (err) {
			if (err instanceof PlayitError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'No longer public: the playit tunnel and its address are deleted.' };
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

	snapshotSchedule: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const time = String(form.get('snapshotDailyTime') ?? '');
		if (form.get('snapshotEvery') === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
			return fail(400, { ok: false, message: 'Give the snapshot time as HH:MM.' });
		}
		const schedule = validSchedule({
			every: form.get('snapshotEvery'),
			dailyTime: time,
			intervalHours: Number(form.get('snapshotIntervalHours')),
			whileRunning: form.get('snapshotWhileRunning'),
			warnMinutes: Number(form.get('snapshotWarnMinutes'))
		});
		saveSnapshotSchedule(instance.id, schedule);
		return { ok: true, message: schedule.every === 'off' ? 'Scheduled snapshots turned off.' : 'Snapshot schedule saved.' };
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

	/**
	 * Guided server.properties fields. Settings posts them a section at a time,
	 * so only the keys on the form are written; the rest keep their values.
	 */
	properties: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const next: Record<string, string> = {
			...(await readProperties(instance.path)).values,
			...propertiesFromForm(form, editableProperties())
		};
		for (const [key, value] of form.entries()) {
			const match = key.match(/^extra:(.+)$/);
			if (match && !MANAGED_KEYS.has(match[1])) next[match[1]] = String(value);
		}
		await writeProperties(instance.path, next);
		await syncPortsToProperties(requireInstance(instance.id));
		return { ok: true, message: 'Saved. Restart the server for the changes to take effect.' };
	},

	propertiesRaw: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const raw = String((await request.formData()).get('raw') ?? '');
		const parsed = parseProperties(raw);
		if (Object.keys(parsed.values).length === 0) {
			return fail(400, { ok: false, message: 'That does not look like a properties file.' });
		}
		// The game port lives in the DB too; a changed one in the raw file moves it.
		const newPort = Number(parsed.values['server-port']);
		if (Number.isInteger(newPort) && newPort !== instance.serverPort) {
			const conflict = portConflict(newPort, instance.id);
			if (conflict) return fail(400, { ok: false, message: conflict });
			db.update(serverInstances)
				.set({ serverPort: newPort, updatedAt: Date.now() })
				.where(eq(serverInstances.id, instance.id))
				.run();
		}
		await writeProperties(instance.path, parsed.values);
		await syncPortsToProperties(requireInstance(instance.id));
		return { ok: true, message: 'File written. Restart to apply.' };
	},

	clone: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const name = String((await request.formData()).get('name') ?? '').trim().slice(0, 80);
		let copy;
		try {
			({ instance: copy } = await cloneInstance(instance, name));
		} catch (err) {
			if (err instanceof InstanceError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		redirect(303, `/instances/${copy.id}`);
	},

	delete: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		// A fixed phrase rather than the instance name: a name with emoji or
		// unusual characters could be impractical to retype, and the friction is
		// the point, not the specific string.
		if (String(form.get('confirm') ?? '').trim().toUpperCase() !== 'DELETE') {
			return fail(400, { ok: false, message: 'Type DELETE to confirm.' });
		}
		await deleteInstance(instance, { deleteFiles: form.get('deleteFiles') === 'on' });
		forgetDiskBreakdown(instance.path);
		redirect(303, '/');
	},

	rescanJava: async ({ params }) => {
		requireInstance(params.id);
		const found = await scanJavaRuntimes();
		return { ok: true, message: `Found ${found.length} Java runtime${found.length === 1 ? '' : 's'}.` };
	}
};
