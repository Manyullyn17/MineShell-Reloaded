import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { serverInstances } from '$lib/server/db/schema';
import { requireInstance, rconPassword, syncPortsToProperties, syncUnit } from '$lib/server/instances';
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
	const java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader
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
			consoleBufferLines: instance.consoleBufferLines
		},
		rconPassword: rconPassword(instance),
		javaRuntimes: listJavaRuntimes(),
		requiredJava: requiredJavaMajor(instance.minecraftVersion),
		javaResolution: java,
		loaders: LOADER_LIST.map((l) => ({ id: l.id, label: l.label }))
	};
};

function bool(form: FormData, key: string): boolean {
	return form.get(key) === 'on';
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
		const modloaderVersion = String(form.get('modloaderVersion') ?? '').trim() || null;

		db.update(serverInstances)
			.set({ name, minecraftVersion, modloaderVersion, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();

		// These fields only relabel the instance. Nothing here reinstalls the
		// loader or swaps the server jar, so saying so plainly beats letting the
		// UI imply an upgrade happened.
		const versionChanged =
			minecraftVersion !== instance.minecraftVersion ||
			modloaderVersion !== instance.modloaderVersion;

		return {
			ok: true,
			message: versionChanged
				? 'Saved. Note this only updates the recorded version - the installed server files are unchanged. Reinstalling to a different version is not supported yet.'
				: 'Saved.'
		};
	},

	runtime: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();

		const maxMb = int(form, 'memoryMaxMb', instance.memoryMaxMb ?? 4096);
		const minMb = int(form, 'memoryMinMb', instance.memoryMinMb ?? 1024);
		if (minMb > maxMb) {
			return fail(400, { ok: false, message: 'Starting memory cannot exceed the maximum.' });
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

	restarts: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const schedule = String(form.get('restartSchedule') ?? 'none');

		db.update(serverInstances)
			.set({
				restartSchedule: ['none', 'interval', 'daily'].includes(schedule) ? schedule : 'none',
				restartIntervalHours: int(form, 'restartIntervalHours', 6),
				restartDailyTime: String(form.get('restartDailyTime') ?? '05:00'),
				restartWarnMinutes: int(form, 'restartWarnMinutes', 5),
				restartSkipIfPlayers: bool(form, 'restartSkipIfPlayers'),
				autoRestartOnCrash: bool(form, 'autoRestartOnCrash'),
				crashRestartLimit: int(form, 'crashRestartLimit', 5),
				crashRestartWindowSec: int(form, 'crashRestartWindowSec', 600),
				updatedAt: Date.now()
			})
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
			.set({
				consoleBacklogLines: int(form, 'consoleBacklogLines', 300),
				consoleBufferLines: int(form, 'consoleBufferLines', 2000),
				updatedAt: Date.now()
			})
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: 'Console preferences saved.' };
	},

	rescanJava: async ({ params }) => {
		requireInstance(params.id);
		const found = await scanJavaRuntimes();
		return { ok: true, message: `Found ${found.length} Java runtime${found.length === 1 ? '' : 's'}.` };
	}
};
