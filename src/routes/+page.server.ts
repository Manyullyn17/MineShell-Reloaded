import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.js';
import { instanceTags, serverInstances, serverTags } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { assignServerTag, createOrFindServerTag, findServerTag, removeServerTag } from '#lib/server/servertags.js';
import { fail } from '@sveltejs/kit';
import { onlinePlayers, requireInstance, restart, start, stop, summariseAll } from '#lib/server/instances.js';
import { latestSample } from '#lib/server/monitor.js';
import { describeSchedule } from '#lib/server/scheduler.js';
import { probeSystemd, templateUnitInstalled } from '#lib/server/systemd.js';
import { TEMPLATE_UNIT } from '#lib/server/config.js';
import { listJavaRuntimes } from '#lib/server/java.js';
import { LOADERS, type ModloaderId } from '#lib/server/modloaders.js';
import { gaveUpAfter } from '#lib/shared/format.js';
import { likelyCause } from '#lib/server/lastcrash.js';

export const load: PageServerLoad = async () => {
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

/** The dashboard's start/stop buttons post here so they work without JavaScript. */
export const actions: Actions = {
	addTag: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const tagId = String(form.get('tagId') ?? '');
		const name = String(form.get('name') ?? '').trim();
		let instance;
		try {
			instance = requireInstance(id);
		} catch {
			return fail(404, { ok: false, message: 'That server no longer exists.' });
		}
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
	removeTag: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const tagId = String(form.get('tagId') ?? '');
		let instance;
		try {
			instance = requireInstance(id);
		} catch {
			return fail(404, { ok: false, message: 'That server no longer exists.' });
		}
		removeServerTag(instance.id, tagId);
		return { ok: true, message: `Removed the tag from ${instance.name}.` };
	},
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
