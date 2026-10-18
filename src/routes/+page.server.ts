import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.js';
import { instanceTags, serverTags } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { onlinePlayers, summariseAll } from '#lib/server/instances.js';
import { sees } from '#lib/server/access.js';
import { latestSample } from '#lib/server/monitor.js';
import { describeSchedule } from '#lib/server/scheduler.js';
import { probeSystemd, templateUnitInstalled } from '#lib/server/systemd.js';
import { TEMPLATE_UNIT } from '#lib/server/config.js';
import { listJavaRuntimes } from '#lib/server/java.js';
import { LOADERS, type ModloaderId } from '#lib/server/modloaders.js';
import { gaveUpAfter } from '#lib/shared/format.js';
import { likelyCause } from '#lib/server/lastcrash.js';

export const load: PageServerLoad = async ({ locals }) => {
	const [tagRows, allTags] = await Promise.all([
		db.select({ instanceId: instanceTags.instanceId, id: serverTags.id, name: serverTags.name })
			.from(instanceTags)
			.innerJoin(serverTags, eq(instanceTags.tagId, serverTags.id))
			.all(),
		db.select({ id: serverTags.id, name: serverTags.name }).from(serverTags).orderBy(serverTags.name).all()
	]);
	const tagsByInstance = new Map<string, { id: string; name: string }[]>();
	for (const tag of tagRows) {
		tagsByInstance.set(tag.instanceId, [
			...(tagsByInstance.get(tag.instanceId) ?? []),
			{ id: tag.id, name: tag.name }
		]);
	}

	// Only the servers this account may see. The tag names stay shared, like the tags themselves.
	const summaries = await summariseAll(sees(locals.access));
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
				tags: tagsByInstance.get(summary.instance.id) ?? [],
				minecraftVersion: summary.instance.minecraftVersion,
				modloader: summary.instance.modloader,
				modloaderLabel: LOADERS[summary.instance.modloader as ModloaderId]?.label ?? summary.instance.modloader,
				modloaderVersion: summary.instance.modloaderVersion,
				packName: summary.instance.packName,
				port: summary.instance.serverPort,
				pinned: summary.instance.pinned,
				status: summary.instance.status,
				statusMessage: summary.instance.statusMessage,
				active: summary.state.active,
				sub: summary.state.sub,
				running: summary.running,
				starting: summary.starting,
				gaveUpAfter: gaveUpAfter(summary.state.active, summary.state.result, summary.instance.crashRestartLimit),
				uptimeMs: summary.uptimeMs,
				eulaAccepted: summary.eulaAccepted,
				iconVersion: summary.iconVersion,
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

	// Streamed: indexing a crashed pack's mods takes a moment the first time.
	// Only servers systemd marks failed, which their cards already show as
	// crashed; the list polls every few seconds and the rest needs their log.
	const causes = Promise.all(
		summaries
			.filter((s) => s.state.active === 'failed')
			.map(async (s) => [s.instance.id, await likelyCause(s).catch(() => null)] as const)
	).then((pairs) => Object.fromEntries(pairs.filter(([, cause]) => cause)) as Record<string, string>);

	return {
		instances,
		tags: allTags,
		causes,
		environment: {
			systemdAvailable: systemd.available,
			systemdMessage: systemd.message,
			unitInstalled,
		/** The template's real name: the unit prefix is configurable (MINESHELL_UNIT_PREFIX). */
		templateUnit: TEMPLATE_UNIT,
			javaCount
		}
	};
};
