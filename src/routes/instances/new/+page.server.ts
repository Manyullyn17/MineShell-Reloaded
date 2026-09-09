import { fail, isRedirect, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { LOADER_LIST, listReleaseVersions, type ModloaderId } from '$lib/server/modloaders';
import {
	createFromArchive,
	createFromLoader,
	createFromPack,
	createFromPackUrl
} from '$lib/server/instances';
import { getProvider } from '$lib/server/mods';
import { packFromFileList } from '$lib/server/packs';
import { listJavaRuntimes } from '$lib/server/java';
import { totalmem } from 'node:os';

export const load: PageServerLoad = async () => {
	// The metadata servers are third-party; a failure should not blank the form.
	const minecraftVersions = await listReleaseVersions().catch(() => [] as string[]);
	const totalMb = Math.floor(totalmem() / (1024 * 1024));

	return {
		loaders: LOADER_LIST.map((l) => ({
			id: l.id,
			label: l.label,
			blurb: l.blurb,
			supportsMods: l.supportsMods
		})),
		minecraftVersions: minecraftVersions.slice(0, 60),
		javaRuntimes: listJavaRuntimes().map((j) => ({
			path: j.path,
			majorVersion: j.majorVersion,
			versionString: j.versionString
		})),
		// Leave headroom for the OS and MineShell itself.
		suggestedMaxMb: Math.max(1024, Math.min(totalMb - 2048, 16384))
	};
};

function memoryFrom(form: FormData) {
	const maxMb = Number(form.get('memoryMaxMb') ?? 4096);
	const minMb = Number(form.get('memoryMinMb') ?? Math.min(1024, maxMb));
	return {
		memoryMaxMb: Number.isFinite(maxMb) && maxMb > 512 ? Math.round(maxMb) : 4096,
		memoryMinMb: Number.isFinite(minMb) && minMb > 256 ? Math.round(minMb) : 1024
	};
}

export const actions: Actions = {
	/** Bare mod loader, no pack. */
	loader: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const minecraftVersion = String(form.get('minecraftVersion') ?? '').trim();
		const modloader = String(form.get('modloader') ?? 'vanilla') as ModloaderId;
		const modloaderVersion = String(form.get('modloaderVersion') ?? '').trim() || null;

		if (!name) return fail(400, { ok: false, message: 'Give the server a name.' });
		if (!minecraftVersion) {
			return fail(400, { ok: false, message: 'Pick a Minecraft version.' });
		}

		try {
			const { instance } = await createFromLoader({
				name,
				minecraftVersion,
				modloader,
				modloaderVersion,
				javaPath: String(form.get('javaPath') ?? '') || null,
				...memoryFrom(form)
			});
			redirect(303, `/instances/${instance.id}`);
		} catch (err) {
			if (isRedirect(err)) throw err;
			return fail(500, {
				ok: false,
				message: err instanceof Error ? err.message : 'Could not create the server.'
			});
		}
	},

	/** Uploaded .mrpack or CurseForge zip. */
	upload: async ({ request }) => {
		const form = await request.formData();
		const file = form.get('archive');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { ok: false, message: 'Choose a .mrpack or CurseForge pack zip.' });
		}

		const name = String(form.get('name') ?? '').trim();
		try {
			const buffer = Buffer.from(await file.arrayBuffer());
			const { instance } = await createFromArchive(name, buffer, memoryFrom(form));
			redirect(303, `/instances/${instance.id}`);
		} catch (err) {
			if (isRedirect(err)) throw err;
			return fail(400, {
				ok: false,
				message: err instanceof Error ? err.message : 'Could not read that archive.'
			});
		}
	},

	/** A pack picked from Modrinth, CurseForge or FTB. */
	install: async ({ request }) => {
		const form = await request.formData();
		const source = String(form.get('source') ?? 'modrinth');
		const projectId = String(form.get('projectId') ?? '');
		const versionId = String(form.get('versionId') ?? '');
		const name = String(form.get('name') ?? '').trim();

		if (!projectId || !versionId) {
			return fail(400, { ok: false, message: 'Pick a pack and a version first.' });
		}

		try {
			const provider = getProvider(source);
			const version = await provider.getVersion(projectId, versionId);
			const project = await provider.getProject(projectId);

			if (source === 'modrinth') {
				// Modrinth ships a real .mrpack archive.
				const file = version.files.find((f) => f.primary) ?? version.files[0];
				if (!file) {
					return fail(400, {
						ok: false,
						message: 'That Modrinth version has no downloadable pack file.'
					});
				}
				const { instance } = await createFromPackUrl({
					name: name || project.name,
					url: file.url,
					source,
					projectId,
					versionId,
					overrides: memoryFrom(form)
				});
				redirect(303, `/instances/${instance.id}`);
			}

			// CurseForge and FTB come back as a file list rather than an archive.
			const loader = (version.loaders[0] ?? 'forge') as ModloaderId;
			const pack = packFromFileList({
				name: project.name,
				version: version.versionNumber,
				minecraftVersion: version.gameVersions[0] ?? '',
				modloader: loader,
				modloaderVersion: null,
				files: version.files.map((f) => ({
					path: 'mods',
					name: f.filename,
					url: f.url,
					sha1: f.hash?.algo === 'sha1' ? f.hash.value : null
				}))
			});

			if (!pack.minecraftVersion) {
				return fail(400, {
					ok: false,
					message:
						'That version does not declare a Minecraft version. Download the pack and use the upload option instead.'
				});
			}

			const { instance } = await createFromPack(
				name || project.name,
				pack,
				{ source, projectId, versionId },
				memoryFrom(form)
			);
			redirect(303, `/instances/${instance.id}`);
		} catch (err) {
			if (isRedirect(err)) throw err;
			return fail(500, {
				ok: false,
				message: err instanceof Error ? err.message : 'Could not install that pack.'
			});
		}
	}
};
