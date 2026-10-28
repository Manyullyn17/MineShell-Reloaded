import { fail, isHttpError } from '@sveltejs/kit';
import { requireAccess } from '#lib/server/access.js';
import type { Actions, PageServerLoad } from './$types';
import { bisectState, cancelBisect, clearBisectState, isBisecting, startBisect } from '#lib/server/bisect.js';
import { OperationInProgressError } from '#lib/server/operations.js';
import { cleanroomDisabledReasons, isCleanroomRequiredJar } from '#lib/server/cleanroom.js';
import { InstanceError, requireInstance, summarise } from '#lib/server/instances.js';
import { duplicateMods, indexMods, requiredBy } from '#lib/server/crashdiag.js';
import { fileVersionPairs } from '#lib/server/formvalues.js';
import { applyDatapackUpdates, changeModVersions, syncInstanceMods, trackable } from '#lib/server/modupdates.js';
import { decideSnapshot, snapshotPrompt, SnapshotChoiceNeeded } from '#lib/server/snapshots.js';
import type { ServerInstance } from '#lib/server/db/schema.js';
import {
	deleteMod,
	getModProvider,
	installModVersion,
	listInstanceMods,
	modsDir,
	setModEnabled,
	setModLocked,
	trackManualJar
} from '#lib/server/mods/index.js';
import { dropFromModNotice } from '#lib/server/modnotice.js';
import { getLoader, LOADER_FALLBACKS, type ModloaderId } from '#lib/server/modloaders.js';
import { installDatapackVersion, isDatapackVersion, listDatapacks, removeDatapack } from '#lib/server/mods/datapacks.js';
import { saveUpload } from '#lib/server/files.js';
import { db } from '#lib/server/db/index.js';
import { serverInstances } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import path from 'node:path';

/**
 * Adding, removing or toggling a mod changes what the server will actually run,
 * so it counts as changing the instance. Without this the overview's "last
 * changed" would only ever move on a settings save.
 */
function touchInstance(id: string) {
	db.update(serverInstances).set({ updatedAt: Date.now() }).where(eq(serverInstances.id, id)).run();
}

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const summary = await summarise(instance);
	const mods = await listInstanceMods(instance);
	const datapacks = await listDatapacks(instance);
	const loader = getLoader(instance.modloader);
	const catalogLoader = loader.catalogLoader ?? loader.id;
	const jars = indexMods(modsDir(instance.path));

	return {
		mods,
		/** Enabled jars declaring the same mod id; streamed, since a big pack's jars take a while to read the first time. */
		duplicates: jars.then(duplicateMods),
		/** By file name, the enabled mods that need it to start; streamed with the duplicates. */
		requiredBy: jars.then(requiredBy),
		/** On Cleanroom: disabled jars its must-remove list covers, by file name, with why. */
		cleanroomOff: instance.modloader === 'cleanroom' ? await cleanroomDisabledReasons(instance.path) : {},
		datapacks,
		running: summary.running,
		busy: instance.status === 'provisioning',
		/** Changing single mods of a modpack is opt-in on the page; the pack's version is the usual thing to change. */
		packName: instance.packSource ? (instance.packName ?? 'a modpack') : null,
		snapshotPrompt: await snapshotPrompt(instance),
		supportsMods: loader.supportsMods,
		modloader: instance.modloader,
		/** What mod catalogs call this loader; Cleanroom mods are listed as Forge. */
		catalogLoader,
		minecraftVersion: instance.minecraftVersion,
		/** Loaders whose mods usually work here too, used to widen the search. */
		compatibleLoaders: [
			catalogLoader,
			...(LOADER_FALLBACKS[instance.modloader as ModloaderId] ?? [])
		],
		bisect: {
			state: bisectState(instance.id),
			running: isBisecting(instance.id),
			/** Mods Cleanroom needs (Fugue, Scalar): offered kept on, a search without them is pointless. */
			keepByDefault: mods.filter((m) => m.enabled && isCleanroomRequiredJar(m.fileName)).map((m) => m.fileName)
		},
		counts: {
			total: mods.length,
			enabled: mods.filter((m) => m.enabled && !m.missing).length,
			untracked: mods.filter((m) => m.untracked).length,
			missing: mods.filter((m) => m.missing).length
		}
	};
};

/** While the bisect assistant searches it turns mods on and off itself: nothing else changes them. */
function bisectBusy(id: string) {
	return isBisecting(id)
		? fail(409, { ok: false, message: 'A search for the mod behind a crash is running. Wait for it, or cancel it, first.' })
		: null;
}

/** A modpack's mods change only once the page's "change single mods" toggle is on. */
function packGuard(instance: ServerInstance, form: FormData) {
	if (instance.packSource && form.get('packMods') !== 'on') {
		return fail(400, {
			ok: false,
			message: 'This server runs a modpack. Turn on changing single mods first, or change the pack version instead.'
		});
	}
	return null;
}

function refused(err: unknown) {
	if (err instanceof InstanceError || err instanceof SnapshotChoiceNeeded) return fail(400, { ok: false, message: err.message });
	throw err;
}

export const actions: Actions = {
	bisect: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const logText = String(form.get('logText') ?? '').trim() || null;
		try {
			await startBisect(instance, { keepOn: form.getAll('keepOn').map(String), logText });
		} catch (err) {
			if (err instanceof InstanceError || err instanceof OperationInProgressError) return fail(409, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'Searching. It runs in the background; progress is shown here and in the notifications.' };
	},

	bisectCancel: async ({ params }) => {
		cancelBisect(params.id);
		return { ok: true, message: 'Cancelling after the current test; the server is then put back as it was.' };
	},

	bisectDismiss: async ({ params }) => {
		if (!isBisecting(params.id)) clearBisectState(params.id);
		return { ok: true };
	},

	/** "Update mods": the reviewed list, each `change` field being "<fileName>\n<versionId>". */
	updateMods: async ({ request, params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const guard = packGuard(instance, form);
		if (guard) return guard;
		const changes = fileVersionPairs(form);
		if (!changes.length) return fail(400, { ok: false, message: 'Tick at least one mod to update.' });
		try {
			await changeModVersions(instance, changes, {
				snapshot: await decideSnapshot(instance, form.get('snapshot')),
				label: `Updating ${changes.length} mod${changes.length === 1 ? '' : 's'}`,
				disableUnneeded: form.getAll('disableUnneeded').map(String)
			});
			return { ok: true, message: 'Updating mods. Follow it in Activity; the server stays stopped until it finishes.' };
		} catch (err) {
			return refused(err);
		}
	},

	/** One mod to a version of the person's choosing, older ones included. */
	changeVersion: async ({ request, params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const guard = packGuard(instance, form);
		if (guard) return guard;
		const fileName = String(form.get('fileName') ?? '');
		const versionId = String(form.get('versionId') ?? '');
		const label = String(form.get('label') ?? '').slice(0, 120) || fileName;
		if (!fileName || !versionId) return fail(400, { ok: false, message: 'Pick a version.' });
		try {
			await changeModVersions(instance, [{ fileName, versionId }], {
				snapshot: form.get('snapshot') === 'on',
				label: `Switching ${label}`,
				disableUnneeded: form.getAll('disableUnneeded').map(String)
			});
			return { ok: true, message: `Switching ${label}. Follow it in Activity.` };
		} catch (err) {
			return refused(err);
		}
	},

	toggle: async ({ request, params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const fileName = String(form.get('fileName') ?? '');
		const enabled = form.get('enabled') === 'true';
		try {
			await setModEnabled(instance, fileName, enabled);
			touchInstance(instance.id);
			return { ok: true, message: `${fileName} ${enabled ? 'enabled' : 'disabled'}. Restart to apply.` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not rename that file.' });
		}
	},

	lock: async ({ request, params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const fileName = String(form.get('fileName') ?? '');
		const locked = form.get('locked') === 'true';
		const mod = (await listInstanceMods(instance)).find((m) => m.fileName === fileName);
		if (!mod || !trackable(mod) || !setModLocked(instance, mod.filePath, locked))
			return fail(400, { ok: false, message: 'Only mods from Modrinth or CurseForge are in update checks.' });
		if (locked) dropFromModNotice(instance.id, fileName);
		return {
			ok: true,
			message: locked ? `${mod.name} is held at ${mod.version ?? 'its version'}: update checks leave it out.` : `${mod.name} is in update checks again.`
		};
	},

	remove: async ({ request, params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const fileName = String((await request.formData()).get('fileName') ?? '');
		await deleteMod(instance, fileName);
		touchInstance(instance.id);
		return { ok: true, message: `Deleted ${fileName}.` };
	},

	upload: async ({ request, params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const files = form.getAll('jars').filter((f): f is File => f instanceof File && f.size > 0);
		if (!files.length) return fail(400, { ok: false, message: 'Choose one or more .jar files.' });

		const added: string[] = [];
		for (const file of files) {
			if (!/\.jar$/i.test(file.name)) continue;
			await saveUpload(modsDir(instance.path), path.basename(file.name), file);
			await trackManualJar(instance, path.basename(file.name));
			added.push(file.name);
		}
		if (!added.length) return fail(400, { ok: false, message: 'None of those were .jar files.' });
		touchInstance(instance.id);
		return { ok: true, message: `Added ${added.length} mod${added.length === 1 ? '' : 's'}. Restart to load them.` };
	},

	install: async ({ request, params, locals }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const source = String(form.get('source') ?? 'modrinth');
		const projectId = String(form.get('projectId') ?? '');
		const versionId = String(form.get('versionId') ?? '');
		if (!projectId || !versionId) {
			return fail(400, { ok: false, message: 'Pick a mod and a version.' });
		}

		const loader = getLoader(instance.modloader);
		const catalogLoader = loader.catalogLoader ?? loader.id;
		let datapacks = 0;
		/** A data pack release goes into the world's datapacks folder, anything else into mods/. */
		const installVersion = async (
			provider: ReturnType<typeof getModProvider>,
			project: Awaited<ReturnType<ReturnType<typeof getModProvider>['getProject']>>,
			version: Awaited<ReturnType<ReturnType<typeof getModProvider>['getVersion']>>
		) => {
			const meta = { id: project.id, slug: project.slug, name: project.name, projectUrl: project.projectUrl, iconUrl: project.iconUrl };
			const datapack = isDatapackVersion(version, catalogLoader);
			// Known only now: the access policy let in anyone with either permission.
			requireAccess(locals, instance.id, datapack ? 'datapacks' : 'mods');
			if (datapack) {
				datapacks++;
				return installDatapackVersion(instance, provider.id, meta, version);
			}
			return installModVersion(instance, provider.id, meta, version);
		};

		try {
			const provider = getModProvider(source);
			const context = { minecraftVersion: instance.minecraftVersion };
			const [project, version] = await Promise.all([
				provider.getProject(projectId),
				provider.getVersion(projectId, versionId, context)
			]);

			const installed = [await installVersion(provider, project, version)];

			// Dependencies are chosen individually in the UI and arrive as
			// "<projectId>:<versionId>" pairs, so skipping just one is possible.
			const failedDeps: string[] = [];
			for (const raw of form.getAll('dependency')) {
				const [depProjectId, depVersionId] = String(raw).split(':');
				if (!depProjectId || !depVersionId) continue;
				try {
					const [depProject, depVersion] = await Promise.all([
						provider.getProject(depProjectId),
						provider.getVersion(depProjectId, depVersionId, context)
					]);
					installed.push(await installVersion(provider, depProject, depVersion));
				} catch {
					failedDeps.push(depProjectId);
				}
			}

			touchInstance(instance.id);
			const note = failedDeps.length
				? ` ${failedDeps.length} dependenc${failedDeps.length === 1 ? 'y' : 'ies'} could not be installed.`
				: '';
			const when = datapacks && datapacks === installed.length ? 'Restart the server or run /reload' : 'Restart the server';
			return {
				ok: true,
				message: `Installed ${installed.join(', ')}. ${when} to load ${installed.length === 1 ? 'it' : 'them'}.${note}`
			};
		} catch (err) {
			if (isHttpError(err)) throw err;
			return fail(502, {
				ok: false,
				message: err instanceof Error ? err.message : 'Install failed.'
			});
		}
	},

	/** "Update data packs": each `change` field being "<fileName>\n<versionId>", as for mods. */
	updateDatapacks: async ({ request, params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const changes = fileVersionPairs(form);
		if (!changes.length) return fail(400, { ok: false, message: 'Tick at least one data pack to update.' });
		try {
			await applyDatapackUpdates(instance, changes, { snapshot: await decideSnapshot(instance, form.get('snapshot')) });
			return { ok: true, message: 'Updating data packs. Follow it in Activity; the world loads them at its next start or /reload.' };
		} catch (err) {
			return refused(err);
		}
	},

	removeDatapack: async ({ request, params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const fileName = String(form.get('fileName') ?? '');
		try {
			await removeDatapack(instance, fileName, { force: form.get('force') === 'on' });
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not remove it.' });
		}
		return { ok: true, message: `Removed ${fileName}. The world drops it at the next start or /reload.` };
	},

	sync: async ({ params }) => {
		const busy = bisectBusy(params.id);
		if (busy) return busy;
		const instance = requireInstance(params.id);
		const summary = await syncInstanceMods(instance);
		if (summary) touchInstance(instance.id);
		return { ok: true, message: summary ? `Synced: ${summary}.` : 'Everything already matches the records.' };
	}
};
