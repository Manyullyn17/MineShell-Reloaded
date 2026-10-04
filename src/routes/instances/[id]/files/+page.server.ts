import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import {
	createDirectory,
	deleteEntry,
	listDirectory,
	readTextFile,
	renameEntry,
	saveUpload,
	writeTextFile,
	type DirEntry
} from '#lib/server/files.js';
import path from 'node:path';

export const load: PageServerLoad = async ({ params, url }) => {
	const instance = requireInstance(params.id);
	const dir = url.searchParams.get('path') ?? '';
	const edit = url.searchParams.get('edit');

	let entries: DirEntry[];
	let listError: string | null = null;
	try {
		entries = await listDirectory(instance.path, dir);
	} catch (err) {
		entries = [];
		listError = err instanceof Error ? err.message : 'Could not read that folder.';
	}

	let editing: { path: string; contents: string } | null = null;
	if (edit) {
		try {
			editing = { path: edit, contents: await readTextFile(instance.path, edit) };
		} catch (err) {
			listError = err instanceof Error ? err.message : 'Could not open that file.';
		}
	}

	// Breadcrumbs, so it is always obvious where you are inside the instance.
	const parts = dir.split('/').filter(Boolean);
	const crumbs = parts.map((part, i) => ({
		label: part,
		path: parts.slice(0, i + 1).join('/')
	}));

	return {
		dir,
		parentDir: parts.length ? parts.slice(0, -1).join('/') : null,
		crumbs,
		entries,
		editing,
		listError
	};
};

export const actions: Actions = {
	save: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await writeTextFile(
				instance.path,
				String(form.get('path') ?? ''),
				String(form.get('contents') ?? '')
			);
			return { ok: true, message: 'Saved.' };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Save failed.' });
		}
	},

	upload: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const dir = String(form.get('dir') ?? '');
		const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
		if (!files.length) return fail(400, { ok: false, message: 'Choose at least one file.' });
		try {
			for (const file of files) {
				await saveUpload(instance.path, path.posix.join(dir, path.basename(file.name)), file);
			}
			return { ok: true, message: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}.` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Upload failed.' });
		}
	},

	mkdir: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { ok: false, message: 'Give the folder a name.' });
		try {
			await createDirectory(instance.path, path.posix.join(String(form.get('dir') ?? ''), name));
			return { ok: true, message: `Created ${name}.` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not create it.' });
		}
	},

	rename: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const from = String(form.get('from') ?? '');
		const to = String(form.get('to') ?? '').trim();
		if (!to) return fail(400, { ok: false, message: 'Enter a new name.' });
		try {
			await renameEntry(instance.path, from, path.posix.join(path.posix.dirname(from), to));
			return { ok: true, message: 'Renamed.' };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Rename failed.' });
		}
	},

	delete: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const target = String((await request.formData()).get('path') ?? '');
		try {
			await deleteEntry(instance.path, target);
			return { ok: true, message: `Deleted ${target}.` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Delete failed.' });
		}
	}
};
