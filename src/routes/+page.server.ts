import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.js';
import { serverInstances } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import { onlinePlayers, requireInstance, restart, start, stop, summariseAll } from '#lib/server/instances.js';
import { latestSample } from '#lib/server/monitor.js';
import { describeSchedule } from '#lib/server/scheduler.js';
import { probeSystemd, templateUnitInstalled } from '#lib/server/systemd.js';
import { listJavaRuntimes } from '#lib/server/java.js';

export const load: PageServerLoad = async () => {
	const summaries = await summariseAll();
	const systemd = await probeSystemd();
	const unitInstalled = await templateUnitInstalled();
	const javaCount = listJavaRuntimes().length;

	const instances = await Promise.all(
		summaries.map(async (summary) => {
			const sample = latestSample(summary.instance.id);
			const players = summary.running ? await onlinePlayers(summary.instance) : null;
			return {
				id: summary.instance.id,
				name: summary.instance.name,
				minecraftVersion: summary.instance.minecraftVersion,
				modloader: summary.instance.modloader,
				modloaderVersion: summary.instance.modloaderVersion,
				packName: summary.instance.packName,
				port: summary.instance.serverPort,
				pinned: summary.instance.pinned,
				status: summary.instance.status,
				statusMessage: summary.instance.statusMessage,
				active: summary.state.active,
				sub: summary.state.sub,
				running: summary.running,
				uptimeMs: summary.uptimeMs,
				eulaAccepted: summary.eulaAccepted,
				javaWarning: summary.javaWarning,
				schedule: describeSchedule(summary.instance),
				nextRestartAt: summary.instance.restartNextAt,
				cpuPercent: sample?.cpuPercent ?? null,
				memoryBytes: sample?.memoryBytes ?? null,
				memoryMaxMb: summary.instance.memoryMaxMb,
				players: players ? { online: players.online, max: players.max, names: players.names } : null
			};
		})
	);

	return {
		instances,
		environment: {
			systemdAvailable: systemd.available,
			systemdMessage: systemd.message,
			scope: systemd.scope,
			unitInstalled,
			javaCount
		}
	};
};

/** The dashboard's start/stop buttons post here so they work without JavaScript. */
export const actions: Actions = {
	power: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const verb = String(form.get('verb') ?? '');

		let instance;
		try {
			instance = requireInstance(id);
		} catch {
			return fail(404, { ok: false, message: 'That server no longer exists.' });
		}

		const result =
			verb === 'start'
				? await start(instance)
				: verb === 'stop'
					? await stop(instance)
					: verb === 'restart'
						? await restart(instance)
						: { ok: false, message: `Unknown action "${verb}".` };

		return result.ok ? result : fail(400, result);
	},

	pin: async ({ request }) => {
		const id = String((await request.formData()).get('id') ?? '');
		let instance;
		try {
			instance = requireInstance(id);
		} catch {
			return fail(404, { ok: false, message: 'That server no longer exists.' });
		}

		db.update(serverInstances)
			.set({ pinned: !instance.pinned, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();

		return {
			ok: true,
			message: instance.pinned
				? `${instance.name} unpinned.`
				: `${instance.name} pinned to the top.`
		};
	}
};
