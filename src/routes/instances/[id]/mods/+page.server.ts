import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { InstanceError, requireInstance, summarise } from '$lib/server/instances';
import { changeModVersions, syncInstanceMods } from '$lib/server/modupdates';
import { decideSnapshot, snapshotPrompt, SnapshotChoiceNeeded } from '$lib/server/snapshots';
import type { ServerInstance } from '$lib/server/db/schema';
import {
	deleteMod,
	getModProvider,
	installModVersion,
	listInstanceMods,
	modsDir,
	setModEnabled,
	setModLocked,
	trackManualJar
} from '$lib/server/mods';
import { getLoader, LOADER_FALLBACKS, type ModloaderId } from '$lib/server/modloaders';
import { saveUpload } from '$lib/server/files';
import { db } from '$lib/server/db';
import { serverInstances } from '$lib/server/db/schema';
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
	const loader = getLoader(instance.modloader);
	const catalogLoader = loader.catalogLoader ?? loader.id;

	return {
		mods,
		running: summary.running,
		busy: instance.status === 'provisioning',
		/** Changing single mods of a modpack is opt-in on the page; the pack's version is the usual thing to change. */
		packName: instance.packSource ? (instance.packName ?? 'a modpack') : null,
		snapshotPrompt: await snapshotPrompt(instance.path),
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
		counts: {
			total: mods.length,
			enabled: mods.filter((m) => m.enabled && !m.missing).length,
			untracked: mods.filter((m) => m.untracked).length,
			missing: mods.filter((m) => m.missing).length
		}
	};
};

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
	/** "Update mods": the reviewed list, each `change` field being "<fileName>\n<versionId>". */
	updateMods: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const guard = packGuard(instance, form);
		if (guard) return guard;
		const changes = form
			.getAll('change')
			.map(String)
			.map((v) => v.split('\n'))
			.filter((p) => p.length === 2 && p[0] && p[1])
			.map(([fileName, versionId]) => ({ fileName, versionId }));
		if (!changes.length) return fail(400, { ok: false, message: 'Tick at least one mod to update.' });
		try {
			await changeModVersions(instance, changes, {
				snapshot: await decideSnapshot(instance.path, form.get('snapshot')),
				label: `Updating ${changes.length} mod${changes.length === 1 ? '' : 's'}`
			});
			return { ok: true, message: 'Updating mods. Follow it in Tasks; the server stays stopped until it finishes.' };
		} catch (err) {
			return refused(err);
		}
	},

	/** One mod to a version of the person's choosing, older ones included. */
	changeVersion: async ({ request, params }) => {
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
				label: `Switching ${label}`
			});
			return { ok: true, message: `Switching ${label}. Follow it in Tasks.` };
		} catch (err) {
			return refused(err);
		}
	},

	toggle: async ({ request, params }) => {
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
		const instance = requireInstance(params.id);
		const form = await request.formData();
		setModLocked(instance, String(form.get('filePath') ?? ''), form.get('locked') === 'true');
		touchInstance(instance.id);
		return { ok: true, message: 'Updated.' };
	},

	remove: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const fileName = String((await request.formData()).get('fileName') ?? '');
		await deleteMod(instance, fileName);
		touchInstance(instance.id);
		return { ok: true, message: `Deleted ${fileName}.` };
	},

	upload: async ({ request, params }) => {
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

	install: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const source = String(form.get('source') ?? 'modrinth');
		const projectId = String(form.get('projectId') ?? '');
		const versionId = String(form.get('versionId') ?? '');
		if (!projectId || !versionId) {
			return fail(400, { ok: false, message: 'Pick a mod and a version.' });
		}

		try {
			const provider = getModProvider(source);
			const context = { minecraftVersion: instance.minecraftVersion };
			const [project, version] = await Promise.all([
				provider.getProject(projectId),
				provider.getVersion(projectId, versionId, context)
			]);

			const installed = [
				await installModVersion(
					instance,
					provider.id,
					{
						id: project.id,
						slug: project.slug,
						name: project.name,
						projectUrl: project.projectUrl,
						iconUrl: project.iconUrl
					},
					version
				)
			];

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
					installed.push(
						await installModVersion(
							instance,
							provider.id,
							{
								id: depProject.id,
								slug: depProject.slug,
								name: depProject.name,
								projectUrl: depProject.projectUrl,
								iconUrl: depProject.iconUrl
							},
							depVersion
						)
					);
				} catch {
					failedDeps.push(depProjectId);
				}
			}

			touchInstance(instance.id);
			const note = failedDeps.length
				? ` ${failedDeps.length} dependenc${failedDeps.length === 1 ? 'y' : 'ies'} could not be installed.`
				: '';
			return {
				ok: true,
				message: `Installed ${installed.join(', ')}. Restart the server to load ${installed.length === 1 ? 'it' : 'them'}.${note}`
			};
		} catch (err) {
			return fail(502, {
				ok: false,
				message: err instanceof Error ? err.message : 'Install failed.'
			});
		}
	},

	sync: async ({ params }) => {
		const instance = requireInstance(params.id);
		const summary = await syncInstanceMods(instance);
		if (summary) touchInstance(instance.id);
		return { ok: true, message: summary ? `Synced: ${summary}.` : 'Everything already matches the records.' };
	}
};
