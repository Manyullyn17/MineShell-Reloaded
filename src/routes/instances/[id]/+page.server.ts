import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { serverInstances } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	acceptEula,
	deleteInstance,
	instanceDiskUsage,
	onlinePlayers,
	requireInstance,
	restart,
	start,
	stop,
	summarise,
	wasStopIntentional
} from '$lib/server/instances';
import { bucketSamples, recentSamples } from '$lib/server/monitor';
import { resolveJava } from '$lib/server/java';
import { cpus, hostname, networkInterfaces } from 'node:os';
import { describeSchedule } from '$lib/server/scheduler';
import { readJournal } from '$lib/server/journal';
import { redirect } from '@sveltejs/kit';

/**
 * First non-internal IPv4 address found across interfaces. Falls back to the
 * hostname if the machine somehow has none (e.g. no network up at all) -
 * still wrong on a typical LAN, but no worse than before.
 */
function primaryLanAddress(): string {
	for (const addrs of Object.values(networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family === 'IPv4' && !addr.internal) return addr.address;
		}
	}
	return hostname();
}

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const summary = await summarise(instance);
	const samples = bucketSamples(recentSamples(instance.id));
	const players = summary.running ? await onlinePlayers(instance) : null;
	// Which runtime actually gets used, so the overview can name it instead of
	// only saying that matching happens.
	const java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader
	});

	return {
		summary: {
			uptimeMs: summary.uptimeMs,
			javaWarning: summary.javaWarning,
			restarts: summary.state.nRestarts,
			mainPid: summary.state.mainPid,
			result: summary.state.result
		},
		detail: {
			jvmArgs: instance.jvmArgs,
			memoryMaxMb: instance.memoryMaxMb,
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
			minecraftVersion: instance.minecraftVersion,
			modloaderVersion: instance.modloaderVersion,
			java: {
				path: java.path,
				majorVersion: java.majorVersion,
				requiredMajor: java.requiredMajor,
				pinned: java.origin === 'explicit'
			},
			// The address players actually connect to. The bind address is usually
			// blank (all interfaces). A bare hostname needs mDNS or local DNS to
			// resolve from another LAN machine, which most home networks don't
			// have set up (confirmed: it doesn't resolve here) - the LAN IPv4
			// address is what actually works, so that's shown instead.
			host: primaryLanAddress()
		},
		players,
		diskBytes: await instanceDiskUsage(instance),
		// CPU is measured across all cores, so the chart needs the core count to
		// show a meaningful ceiling instead of an unexplained 400%.
		cpuCores: cpus().length || 1,
		cpu: samples.map((s) => ({ timestamp: s.timestamp, value: s.cpuPercent })),
		memory: samples.map((s) => ({ timestamp: s.timestamp, value: s.memoryBytes })),
		// Shown only when the last run ended badly, so a crash is not silent. A
		// stop MineShell asked for reports the same systemd Result as a crash, so
		// intent is checked rather than inferred from the unit state.
		crashTail:
			(summary.state.active === 'failed' || summary.state.result === 'exit-code') &&
			!wasStopIntentional(instance.id)
				? (await readJournal(instance.id, 40)).split('\n').slice(-40).join('\n')
				: null
	};
};

export const actions: Actions = {
	power: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const verb = String((await request.formData()).get('verb') ?? '');
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

	eula: async ({ params }) => {
		await acceptEula(requireInstance(params.id));
		return { ok: true, message: 'EULA accepted. You can start the server now.' };
	},

	pin: async ({ params }) => {
		const instance = requireInstance(params.id);
		db.update(serverInstances)
			.set({ pinned: !instance.pinned, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: instance.pinned ? 'Unpinned.' : 'Pinned to the top of the list.' };
	},

	notes: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const notes = String((await request.formData()).get('notes') ?? '').slice(0, 4000);
		db.update(serverInstances)
			.set({ notes, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: 'Notes saved.' };
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
		redirect(303, '/');
	}
};
