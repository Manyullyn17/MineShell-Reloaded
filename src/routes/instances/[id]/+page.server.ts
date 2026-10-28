import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { can } from '#lib/shared/access.js';
import { packIconPending } from '#lib/server/packicon.js';
import { clearCrashes, crashesClearable, crashFixPending, hungAfterCrash, noteCrashFix, onlineSince, peakPlayers, recentCrashes, startTimes } from '#lib/server/history.js';
import { db } from '#lib/server/db/index.js';
import { serverInstances } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { answerForgeQuestion, pendingForgeQuestion } from '#lib/server/forgequery.js';
import {
	acceptEula,
	InstanceError,
	listInstances,
	onlinePlayers,
	requireInstance,
	restart,
	start,
	stop,
	summarise
} from '#lib/server/instances.js';
import { bucketSamples, recentSamples } from '#lib/server/monitor.js';
import { heapSamplesSince, runningHeapMb } from '#lib/server/heap.js';
import { memoryAdvice } from '#lib/server/memoryadvice.js';
import { resolveJava } from '#lib/server/java.js';
import { cpus } from 'node:os';
import { primaryLanAddress } from '#lib/server/network.js';
import { recentDiskBreakdown } from '#lib/server/diskusage.js';
import { describeSchedule } from '#lib/server/scheduler.js';
import { forgetDiagnosis, lastCrash } from '#lib/server/lastcrash.js';
import { setModEnabled } from '#lib/server/mods/index.js';
import { TICK_LIMIT_STEPS } from '#lib/server/crashdiag.js';
import { patchProperties } from '#lib/server/properties.js';
import { cancelCountdown, getCountdown, startCountdown } from '#lib/server/countdown.js';
import { tickStats } from '#lib/server/tps.js';
import { kickPlayer } from '#lib/server/players.js';
import { facesByName } from '#lib/server/playerdata.js';
import {
	activeProfile,
	cancelProfile,
	hasSpark,
	PROFILE_SECONDS,
	SparkError,
	sparkUploads,
	startProfile,
	stopProfile,
	uploadSavedProfile
} from '#lib/server/spark.js';
import { voiceChat } from '#lib/server/voicechat.js';
import { forgetMissing, readMissing, startRetryMissing } from '#lib/server/packs/missing.js';
import { isAllowedAddress } from '#lib/server/downloadaccess.js';
import { assignServerTag, createOrFindServerTag, findServerTag, removeServerTag } from '#lib/server/servertags.js';
import { isBisecting } from '#lib/server/bisect.js';
import { currentNotice, modsChecked, skipNotice } from '#lib/server/updatecheck.js';
import { currentModNotice, skipModNotice } from '#lib/server/modnotice.js';
import { startMemoryWarning } from '#lib/server/memoryguard.js';
import { unitState } from '#lib/server/systemd.js';
import { stuckStarting } from '#lib/server/stuck.js';

/** The performance chart's windows; the monitor keeps a day of samples. */
const RANGES = { '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 } as const;
type Range = keyof typeof RANGES;

export const load: PageServerLoad = async ({ params, url, locals }) => {
	const instance = requireInstance(params.id);
	const summary = await summarise(instance);
	const requested = url.searchParams.get('range');
	const range: Range = requested && Object.hasOwn(RANGES, requested) ? (requested as Range) : '1h';
	const samples = bucketSamples(recentSamples(instance.id, RANGES[range]));
	const heap = heapSamplesSince(instance.id, Date.now() - RANGES[range]);
	// Shown only when the last run ended badly, so a crash is not silent.
	// Streamed: the first read of a big pack's last run takes 1-2 s.
	const crash = lastCrash(summary).catch(() => null);
	// Both over RCON; side by side, so a slow answer is waited for once.
	const [players, tick] = summary.running
		? await Promise.all([onlinePlayers(instance), tickStats(instance)])
		: [null, null];
	// Forge 1.12 waiting for an answer on the console; it reads its journal by cursor, so polling is cheap.
	const forgeQuestion = summary.running
		? await pendingForgeQuestion(instance, summary.state.activeEnterTimestamp).catch(() => null)
		: null;
	// Crashed, but the process never exited (lastCrash then reports it too).
	const hungSince = summary.running ? hungAfterCrash(instance.id, summary.state.activeEnterTimestamp) : null;
	const stuck =
		summary.running &&
		!forgeQuestion &&
		hungSince === null &&
		(await stuckStarting(instance.id, instance.createdAt, summary.state.activeEnterTimestamp));
	// Which runtime actually gets used, so the overview can name it instead of
	// only saying that matching happens.
	const java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader,
		modloaderVersion: instance.modloaderVersion
	});

	// Streamed: the first look opens every mod jar.
	const spark = hasSpark(instance.path).then(async (has) =>
		has
			? {
					active: activeProfile(instance.id),
					durations: PROFILE_SECONDS,
					// Profiles are the profiler's (console.command) to share.
					uploads: can(locals.access, instance.id, 'console.command') ? (await sparkUploads(instance.path)).slice(0, 5) : []
				}
			: null
	);
	const missingDownloads = await readMissing(instance.path);
	const update = currentNotice(instance);
	const modNotice = instance.updateCheck && modsChecked(instance) ? currentModNotice(instance.id) : null;

	return {
		/** A newer pack version or loader build the periodic check found (updatecheck.ts). */
		update: update && { kind: update.kind, versionId: update.versionId, label: update.label, channel: update.channel },
		/** Mod updates the periodic check found (servers without a pack; modnotice.ts). */
		modUpdates: modNotice,
		summary: {
			uptimeMs: summary.uptimeMs,
			/** When it finished starting, which uptime counts from; null while starting or stopped. */
			startedAt: summary.doneAt,
			/** When the process started, while it has not finished starting. */
			startingSince: summary.starting ? summary.state.activeEnterTimestamp : null,
			javaWarning: summary.javaWarning,
			restarts: summary.state.nRestarts,
			mainPid: summary.state.mainPid,
			result: summary.state.result
		},
		detail: {
			jvmArgs: instance.jvmArgs,
			memoryMaxMb: instance.memoryMaxMb,
			/** What the running process has: a changed setting applies from the next start. */
			runningMemoryMaxMb: summary.running ? await runningHeapMb(summary.state.mainPid) : null,
			memoryMinMb: instance.memoryMinMb,
			crashRestartWindowSec: instance.crashRestartWindowSec,
			javaPath: instance.javaPath,
			rconPort: instance.rconPort,
			autoRestartOnCrash: instance.autoRestartOnCrash,
			crashRestartLimit: instance.crashRestartLimit,
			schedule: describeSchedule(instance),
			nextRestartAt: instance.restartNextAt,
			createdAt: instance.createdAt,
			updatedAt: instance.updatedAt,
			notes: instance.notes,
			serverPort: instance.serverPort,
			// Simple Voice Chat's UDP port, for the firewall hint (null without the mod, or on the game port's number).
			voicePort: await voiceChat(instance).then((v) => (v && v.port !== instance.serverPort ? v.port : null), () => null),
			minecraftVersion: instance.minecraftVersion,
			modloaderVersion: instance.modloaderVersion,
			java: {
				path: java.path,
				majorVersion: java.majorVersion,
				requiredMajor: java.requiredMajor,
				origin: java.origin
			},
			// The address players actually connect to. The bind address is usually
			// blank (all interfaces). A bare hostname needs mDNS or local DNS to
			// resolve from another LAN machine, which most home networks don't
			// have set up (confirmed: it doesn't resolve here) - the LAN IPv4
			// address is what actually works, so that's shown instead.
			host: primaryLanAddress()
		},
		players,
		// Streamed: faces for who is online (skins from Mojang, cached).
		faces: players?.names.length ? facesByName(instance, players.names) : {},
		/** From the journal (history.ts): today's peak, since when each online player is on, start times. */
		history: {
			peakToday: peakPlayers(instance.id),
			onlineSince: onlineSince(instance.id),
			start: startTimes(
				instance.id,
				summary.running ? { startedAt: summary.state.activeEnterTimestamp, doneAt: summary.doneAt } : undefined
			),
			crashes: recentCrashes(instance.id),
			/** A start after the newest crash got to "Done": the list can be cleared. */
			crashesClearable: crashesClearable(instance.id),
			/** A one-click fix was applied: the next clean start clears the list. */
			crashFixPending: crashFixPending(instance.id)
		},
		/** A pack server without an icon yet: the page puts the pack's icon on it, once. */
		packIconPending: await packIconPending(instance),
		countdown: getCountdown(instance.id),
		tick,
		spark,
		stuckSince: stuck ? summary.state.activeEnterTimestamp : null,
		hungSince,
		// Forge's words are console output: in full for whoever answers it; others learn only that it asks.
		forgeQuestion:
			forgeQuestion && !can(locals.access, instance.id, 'software') ? { ...forgeQuestion, text: '', groups: [] } : forgeQuestion,
		/** Pack files the last install or pack change could not download (packs/missing.ts). */
		missingDownloads,
		/** Addresses those downloads were refused for that nobody has allowed since, one each (downloadaccess.ts). */
		blockedDownloads: [
			...new Map(missingDownloads.flatMap((m) => (m.blocked && !isAllowedAddress(m.blocked.address) ? [[m.blocked.address, m.blocked]] as const : []))).values()
		],
		// One walk of the folder serves both numbers, reused for a minute (recentDiskBreakdown).
		// Streamed: the first walk of a big pack takes seconds.
		disk: recentDiskBreakdown(instance).then(
			(b) => ({ diskBytes: b.total, worldBytes: b.groups.find((g) => g.id === 'world')?.bytes ?? 0 }),
			() => ({ diskBytes: 0, worldBytes: 0 })
		),
		// CPU is measured across all cores, so the chart needs the core count to
		// show a meaningful ceiling instead of an unexplained 400%.
		cpuCores: cpus().length || 1,
		range,
		rangeMs: RANGES[range],
		cpu: samples.map((s) => ({ timestamp: s.timestamp, value: s.cpuPercent })),
		memory: samples.map((s) => ({ timestamp: s.timestamp, value: s.memoryBytes })),
		/** Java heap in use, once a minute (heap.ts); empty until the server has run a minute. */
		heap: heap.map((s) => ({ timestamp: s.timestamp, value: s.usedBytes })),
		heapMaxBytes: heap.at(-1)?.maxBytes ?? null,
		// Streamed: it may search the journal for an out-of-memory crash.
		memoryAdvice: memoryAdvice(instance).catch(() => null),
		// That it crashed shows to everyone; its last lines are console output (console.read).
		crash: crash.then((c) =>
			c ? { tail: can(locals.access, instance.id, 'console.read') ? c.log.split('\n').slice(-40).join('\n') : null } : null
		),
		// Indexing a big pack's mods takes a moment the first time.
		// What went wrong, in MineShell's words, for everyone; the log line it came from is console output.
		diagnosis: crash.then(async (c) => {
			const found = c ? await c.diagnosis : null;
			if (!found || can(locals.access, instance.id, 'console.read')) return found;
			return found.map((d) => ({ ...d, evidence: '' }));
		})
	};
};

export const actions: Actions = {
	power: async ({ request, params, url }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const verb = String(form.get('verb') ?? '');
		// The header menu's buttons carry the verb, so their delay is in the URL.
		const rawDelay = String(form.get('delay') ?? url.searchParams.get('delay') ?? '').trim();
		const delay = Number(rawDelay || 0);
		// One out of range used to stop or restart at once: refused, since a warning was asked for.
		if ((verb === 'stop' || verb === 'restart') && !(Number.isInteger(delay) && delay >= 0 && delay <= 3600)) {
			return fail(400, { ok: false, message: 'A delay is a whole number of seconds, up to an hour (3600).' });
		}
		if ((verb === 'stop' || verb === 'restart') && delay > 0) {
			const result = await startCountdown(instance, verb, delay);
			return result.ok ? result : fail(400, result);
		}
		// Acting by hand replaces any countdown still running.
		cancelCountdown(instance.id);
		// Asked again with force=on once the person chose to start anyway.
		if (verb === 'start' && form.get('force') !== 'on') {
			const others = await Promise.all(
				listInstances()
					.filter((other) => other.id !== instance.id)
					.map(async (other) => ({ instance: other, mainPid: (await unitState(other.id)).mainPid || null }))
			);
			const warning = await startMemoryWarning(instance, others).catch(() => null);
			if (warning) return fail(409, { ok: false, message: warning, memoryWarning: true });
		}
		const result =
			verb === 'start'
				? await start(instance)
				: verb === 'stop'
					? await stop(instance)
					: verb === 'kill'
						? await stop(instance, { graceful: false })
						: verb === 'restart'
							? await restart(instance)
							: { ok: false, message: `Unknown action "${verb}".` };
		return result.ok ? result : fail(400, result);
	},

	cancelCountdown: async ({ params }) => {
		return cancelCountdown(params.id)
			? { ok: true, message: 'Countdown cancelled; players were told.' }
			: fail(400, { ok: false, message: 'No countdown is running.' });
	},

	/** The answer to a question Forge waits on at startup (forgequery.ts). */
	forgeAnswer: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const answer = form.get('answer');
		if (answer !== 'confirm' && answer !== 'cancel') return fail(400, { ok: false, message: 'No answer given.' });
		try {
			const { message } = await answerForgeQuestion(instance, answer, { snapshot: form.get('snapshot') === 'on' });
			return { ok: true, message };
		} catch (err) {
			if (err instanceof InstanceError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
	},

	/** Takes the crashes off the overview, once the server started cleanly after them. */
	clearCrashes: async ({ params }) => {
		const instance = requireInstance(params.id);
		if (!clearCrashes(instance.id)) return fail(400, { ok: false, message: 'Start the server cleanly first: crashes clear once a start after them gets through.' });
		return { ok: true, message: 'Crashes cleared from the overview; the Logs tab still has every run.' };
	},

	/** One-click fix from a crash diagnosis: disable the culprit or re-enable a dependency. */
	modFix: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const fileName = String(form.get('fileName') ?? '');
		const enable = form.get('enable') === 'true';
		if (!fileName || fileName.includes('/') || fileName.includes('..')) {
			return fail(400, { ok: false, message: 'No mod given.' });
		}
		if ((await summarise(instance)).running) {
			return fail(400, { ok: false, message: 'Stop the server first.' });
		}
		try {
			await setModEnabled(instance, fileName, enable);
		} catch {
			return fail(400, { ok: false, message: `${fileName} is no longer in the mods folder.` });
		}
		forgetDiagnosis(instance.id);
		noteCrashFix(instance.id);
		const name = fileName.replace(/\.jar(\.disabled)?$/i, '');
		return { ok: true, message: `${enable ? 'Enabled' : 'Disabled'} ${name}. Start the server to try again.` };
	},

	// The watchdog diagnosis' button: max-tick-time raised to one of its steps, nothing else.
	tickLimit: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const ms = Number((await request.formData()).get('ms'));
		if (!TICK_LIMIT_STEPS.includes(ms)) return fail(400, { ok: false, message: 'Not a tick limit MineShell offers.' });
		if ((await summarise(instance)).running) return fail(400, { ok: false, message: 'Stop the server first.' });
		await patchProperties(instance.path, { 'max-tick-time': String(ms) });
		forgetDiagnosis(instance.id);
		noteCrashFix(instance.id);
		return { ok: true, message: `Ticks may now take up to ${ms / 60_000} minutes. Start the server to try again.` };
	},

	profile: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const seconds = Number((await request.formData()).get('seconds'));
		if (!(await summarise(instance)).running) return fail(400, { ok: false, message: 'Start the server first.' });
		try {
			startProfile(instance, seconds);
		} catch (err) {
			if (err instanceof SparkError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'Profiling. The link appears below when Spark has uploaded the result.' };
	},

	profileStop: async ({ params }) => {
		try {
			await stopProfile(requireInstance(params.id));
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof SparkError ? err.message : 'Spark did not answer over RCON.' });
		}
		return { ok: true, message: 'Stopping; Spark uploads what it has so far.' };
	},

	profileCancel: async ({ params }) => {
		try {
			cancelProfile(requireInstance(params.id));
		} catch (err) {
			if (err instanceof SparkError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'Profile cancelled.' };
	},

	profileUpload: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const file = String((await request.formData()).get('file') ?? '');
		try {
			await uploadSavedProfile(instance.path, file);
		} catch (err) {
			if (err instanceof SparkError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'Uploaded; the profile opens from the list below.' };
	},

	kick: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const name = String((await request.formData()).get('name') ?? '').trim();
		if (!name) return fail(400, { ok: false, message: 'No player given.' });
		if ((await kickPlayer(instance, name, '')) === null) {
			return fail(400, { ok: false, message: 'The server is not reachable over RCON.' });
		}
		return { ok: true, message: `Kicked ${name}.` };
	},

	eula: async ({ params }) => {
		await acceptEula(requireInstance(params.id));
		return { ok: true, message: 'EULA accepted. You can start the server now.' };
	},

	/**
	 * What an install or pack change reported (client-only mods disabled,
	 * Cleanroom fixes that failed) stays on a ready server until read. Only
	 * that: a failed setup's message is the reason it failed.
	 */
	dismissNotice: async ({ params }) => {
		const instance = requireInstance(params.id);
		if (instance.status !== 'ready') return fail(400, { ok: false, message: 'Nothing to dismiss.' });
		db.update(serverInstances)
			.set({ statusMessage: null })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true };
	},

	retryDownloads: async ({ params }) => {
		const instance = requireInstance(params.id);
		if (instance.status !== 'ready') return fail(409, { ok: false, message: 'Wait for the server’s setup to finish first.' });
		if (isBisecting(instance.id)) {
			return fail(409, { ok: false, message: 'A search for the mod behind a crash is running. Wait for it, or cancel it, first.' });
		}
		if (!(await readMissing(instance.path)).length) return fail(400, { ok: false, message: 'Nothing is missing any more.' });
		if (!startRetryMissing(instance)) return fail(409, { ok: false, message: 'Already trying again.' });
		return { ok: true, message: 'Downloading again; the list updates when it is done.' };
	},

	forgetDownloads: async ({ params }) => {
		const instance = requireInstance(params.id);
		await forgetMissing(instance.path);
		return { ok: true };
	},

	skipUpdate: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const versionId = String((await request.formData()).get('versionId') ?? '');
		if (!skipNotice(instance.id, versionId)) return fail(400, { ok: false, message: 'That update is no longer the one on offer.' });
		return { ok: true, message: 'Skipped. A newer version shows again; the server Settings can bring this one back.' };
	},

	skipModUpdates: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const fingerprint = String((await request.formData()).get('fingerprint') ?? '');
		if (!skipModNotice(instance.id, fingerprint)) return fail(400, { ok: false, message: 'Those updates are no longer the ones on offer.' });
		return { ok: true, message: 'Hidden. Other updates show again when the check finds them.' };
	},

	pin: async ({ params }) => {
		const instance = requireInstance(params.id);
		db.update(serverInstances)
			.set({ pinned: !instance.pinned, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: instance.pinned ? `${instance.name} unpinned.` : `${instance.name} pinned to the top.` };
	},

	/** The dashboard's tag editor: an existing tag by id, or a new one by name. */
	addTag: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const tagId = String(form.get('tagId') ?? '');
		const name = String(form.get('name') ?? '').trim();
		let tag = tagId ? findServerTag(tagId) : undefined;
		if (tagId && !tag) return fail(404, { ok: false, message: 'That tag no longer exists.' });
		if (!tagId) {
			if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) {
				return fail(400, { ok: false, message: 'Tags must be 1–32 characters and cannot contain control characters.' });
			}
			tag = createOrFindServerTag(name);
		}
		if (!tag) return fail(500, { ok: false, message: 'Could not save that tag.' });
		assignServerTag(instance.id, tag.id);
		return { ok: true, message: `Added “${tag.name}” to ${instance.name}.` };
	},

	removeTag: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		removeServerTag(instance.id, String((await request.formData()).get('tagId') ?? ''));
		return { ok: true, message: `Removed the tag from ${instance.name}.` };
	},

	notes: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const notes = String((await request.formData()).get('notes') ?? '').slice(0, 4000);
		db.update(serverInstances)
			.set({ notes, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: 'Notes saved.' };
	}
};
