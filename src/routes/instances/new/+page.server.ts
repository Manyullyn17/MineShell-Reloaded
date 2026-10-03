import { fail, isRedirect, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { LOADERS, LOADER_LIST, listReleaseVersions, type ModloaderId } from '$lib/server/modloaders';
import {
	JavaMissingError,
	createFromArchive,
	createFromLoader,
	createFromPack
} from '$lib/server/instances';
import { resolveProviderPack } from '$lib/server/packs/resolve';
import { listJavaRuntimes } from '$lib/server/java';
import { isJavaVendor } from '$lib/server/javadownload';
import { defaultMaxMb, getInstanceDefaults } from '$lib/server/instance-defaults';

export const load: PageServerLoad = async () => {
	// The metadata servers are third-party; a failure should not blank the form.
	const minecraftVersions = await listReleaseVersions().catch(() => [] as string[]);
	const defaults = getInstanceDefaults();

	return {
		loaders: LOADER_LIST.map((l) => ({
			id: l.id,
			label: l.label,
			blurb: l.blurb,
			supportsMods: l.supportsMods,
			onlyGameVersions: l.onlyGameVersions ?? null
		})),
		minecraftVersions: minecraftVersions.slice(0, 60),
		javaRuntimes: listJavaRuntimes().map((j) => ({
			path: j.path,
			majorVersion: j.majorVersion,
			versionString: j.versionString
		})),
		// Settings page defaults; the maximum is a RAM-based guess unless one is set.
		suggestedMaxMb: defaultMaxMb(defaults),
		defaultMinMb: defaults.memoryMinMb
	};
};

/** What the form says; anything missing or unusable is left to the stored defaults. */
function downloadJavaFrom(form: FormData) {
	const vendor = form.get('downloadJava');
	return isJavaVendor(vendor) ? { downloadJava: vendor } : {};
}

/** A missing Java comes back to the form it was submitted from, which offers to download it. */
function javaMissing(err: unknown, action: string) {
	return err instanceof JavaMissingError
		? fail(400, { ok: false, message: err.message, javaMissing: { major: err.major, action } })
		: null;
}

function memoryFrom(form: FormData) {
	const maxMb = Number(form.get('memoryMaxMb'));
	const minMb = Number(form.get('memoryMinMb'));
	return {
		memoryMaxMb: form.get('memoryMaxMb') && Number.isFinite(maxMb) && maxMb > 512 ? Math.round(maxMb) : undefined,
		memoryMinMb: form.get('memoryMinMb') && Number.isFinite(minMb) && minMb > 256 ? Math.round(minMb) : undefined
	};
}

/** The CleanroomOption fields; createFromPack ignores them for anything but Forge 1.12.2. */
function cleanroomFrom(form: FormData): { modloader?: ModloaderId; modloaderVersion?: string | null } {
	if (form.get('useCleanroom') !== 'on') return {};
	return {
		modloader: 'cleanroom',
		modloaderVersion: String(form.get('cleanroomVersion') ?? '').trim() || null
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
		const loader = LOADERS[modloader];
		if (!loader) return fail(400, { ok: false, message: `Unknown mod loader "${modloader}".` });
		if (loader.onlyGameVersions && !loader.onlyGameVersions.includes(minecraftVersion)) {
			return fail(400, {
				ok: false,
				message: `${loader.label} only runs on Minecraft ${loader.onlyGameVersions.join(', ')}.`
			});
		}

		try {
			const { instance } = await createFromLoader({
				name,
				minecraftVersion,
				modloader,
				modloaderVersion,
				javaPath: String(form.get('javaPath') ?? '') || null,
				...memoryFrom(form),
				...downloadJavaFrom(form)
			});
			redirect(303, `/instances/${instance.id}`);
		} catch (err) {
			if (isRedirect(err)) throw err;
			return javaMissing(err, 'loader') ?? fail(500, {
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
			const { instance } = await createFromArchive(name, buffer, {
				...memoryFrom(form),
				...cleanroomFrom(form),
				...downloadJavaFrom(form)
			});
			redirect(303, `/instances/${instance.id}`);
		} catch (err) {
			if (isRedirect(err)) throw err;
			return javaMissing(err, 'upload') ?? fail(400, {
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
			const { pack, projectName } = await resolveProviderPack(source, projectId, versionId);
			const { instance } = await createFromPack(
				name || projectName,
				pack,
				{ source, projectId, versionId },
				{ ...memoryFrom(form), ...cleanroomFrom(form), ...downloadJavaFrom(form) }
			);
			redirect(303, `/instances/${instance.id}`);
		} catch (err) {
			if (isRedirect(err)) throw err;
			return javaMissing(err, 'install') ?? fail(500, {
				ok: false,
				message: err instanceof Error ? err.message : 'Could not install that pack.'
			});
		}
	}
};
