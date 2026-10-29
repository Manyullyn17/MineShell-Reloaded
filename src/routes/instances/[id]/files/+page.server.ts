import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import {
	createDirectory,
	listDirectory,
	looksEditable,
	readTextFile,
	renameEntry,
	safeJoin,
	saveUpload,
	uploadPath,
	writeTextFile,
	type DirEntry
} from '#lib/server/files.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { forgetDiskBreakdown, recentDiskBreakdown } from '#lib/server/diskusage.js';
import { sftpAccess } from '#lib/server/sftp.js';
import { deleteToTrash, emptyTrash, listTrash, purgeTrashItem, restoreFromTrash, trashDays } from '#lib/server/trash.js';
import { searchFiles } from '#lib/server/filesearch.js';
import { keepVersion, listVersions, type FileVersion } from '#lib/server/filehistory.js';
import { CONFLICTS_SHOWN, UnpackConflict, unpackZip, type UnpackInto } from '#lib/server/filezips.js';

export const load: PageServerLoad = async ({ params, url }) => {
	const instance = requireInstance(params.id);
	const dir = url.searchParams.get('path') ?? '';
	const edit = url.searchParams.get('edit');
	const search = url.searchParams.get('search')?.trim() || null;
	const trash = await listTrash(instance.path).catch(() => []);
	// The trash, shown in place of a folder.
	const showTrash = url.searchParams.has('trash');

	// A link to a file (disk usage, a leftover) opens its folder: in the editor
	// if it is text, else with the file picked out in the list.
	// A path outside the server folder is refused by the listing below.
	const target = await Promise.resolve()
		.then(() => safeJoin(instance.path, dir))
		.then(async (full) => ({ full, stat: await fs.stat(full) }))
		.catch(() => null);
	if (target?.stat.isFile()) {
		const { stat } = target;
		const file = path.relative(path.resolve(instance.path), target.full);
		const to = new URL(url);
		const folder = path.posix.dirname(file);
		if (folder === '.') to.searchParams.delete('path');
		else to.searchParams.set('path', folder);
		to.searchParams.set(looksEditable(file, stat.size) ? 'edit' : 'show', file);
		redirect(307, to.pathname + to.search);
	}

	let entries: DirEntry[];
	let listError: string | null = null;
	try {
		entries = await listDirectory(instance.path, dir);
	} catch (err) {
		entries = [];
		listError = err instanceof Error ? err.message : 'Could not read that folder.';
	}

	let editing: { path: string; contents: string; line: number | null; find: string | null; versions: FileVersion[] } | null = null;
	if (edit) {
		try {
			// ?line= opens it there (a search result).
			const line = Number(url.searchParams.get('line'));
			editing = {
				path: edit,
				contents: await readTextFile(instance.path, edit),
				line: Number.isInteger(line) && line > 0 ? line : null,
				find: url.searchParams.get('find'),
				versions: await listVersions(instance.path, edit).catch(() => [])
			};
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
		// The file a link pointed at, picked out in the list.
		show: url.searchParams.get('show'),
		parentDir: parts.length ? parts.slice(0, -1).join('/') : null,
		crumbs,
		entries,
		editing,
		listError,
		// "Open in file manager": the folder shown, on this machine, over SSH.
		sftp: await sftpAccess(),
		trash: showTrash ? trash : null,
		trashCount: trash.length,
		trashDays: trashDays(),
		folder: listError ? instance.path : path.join(instance.path, dir),
		// Search in files (?search=, in the folder shown): streamed, a big pack takes a moment.
		search: search && !edit && !showTrash ? searchFiles(instance.path, search, dir).catch((err: unknown) => ({ error: err instanceof Error ? err.message : 'The search failed.' })) : null,
		searchQuery: search ?? '',
		// Streamed and reused for a minute: walking a big pack takes a moment.
		usage: recentDiskBreakdown(instance)
			.then((b) => ({ total: b.total, groups: b.groups.map((g) => ({ id: g.id, label: g.label, bytes: g.bytes })) }))
			.catch(() => null)
	};
};

export const actions: Actions = {
	save: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			const file = String(form.get('path') ?? '');
			const contents = String(form.get('contents') ?? '');
			const kept = await keepVersion(instance.path, file, contents);
			await writeTextFile(instance.path, file, contents);
			return { ok: true, message: kept ? 'Saved. The version it replaced is kept under Earlier versions.' : 'Saved.' };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Save failed.' });
		}
	},

	upload: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const dir = String(form.get('dir') ?? '');
		// Dropped folders send each file's path inside them as its name.
		const withFolders = form.get('withFolders') === '1';
		const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
		if (!files.length) return fail(400, { ok: false, message: 'Choose at least one file.' });
		try {
			for (const file of files) {
				await saveUpload(instance.path, uploadPath(dir, file.name, withFolders), file);
			}
			return { ok: true, message: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}.` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Upload failed.' });
		}
	},

	/**
	 * Unpacks a zip where it lies or into a folder named after it. What it
	 * would replace is listed first; posted again with `replace`, that goes
	 * to the trash.
	 */
	unpack: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const file = String(form.get('path') ?? '');
		const into: UnpackInto = form.get('into') === 'folder' ? 'folder' : 'here';
		try {
			const done = await unpackZip(instance, file, into, { replace: form.get('replace') === '1' });
			forgetDiskBreakdown(instance.path);
			const where = done.target ? `${done.target}/` : 'the server folder';
			const replaced = done.replaced ? ` What it replaced (${done.replaced}) is in the trash.` : '';
			return { ok: true, message: `Unpacked ${done.files} file${done.files === 1 ? '' : 's'} into ${where}.${replaced}` };
		} catch (err) {
			if (err instanceof UnpackConflict) {
				const { conflicts, target } = err.plan;
				return fail(409, {
					ok: false,
					message: err.message,
					unpack: { path: file, into, target, conflicts: conflicts.slice(0, CONFLICTS_SHOWN), conflictCount: conflicts.length }
				});
			}
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not unpack it.' });
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
			const item = await deleteToTrash(instance.path, target);
			forgetDiskBreakdown(instance.path);
			if (!item) return { ok: true, message: `Deleted ${target} for good.` };
			return { ok: true, message: `Moved ${target} to the trash.`, undo: item.id };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Delete failed.' });
		}
	},

	restore: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const id = String((await request.formData()).get('id') ?? '');
		try {
			const to = await restoreFromTrash(instance.path, id);
			forgetDiskBreakdown(instance.path);
			return { ok: true, message: `Restored ${to}.` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Restore failed.' });
		}
	},

	purge: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const id = String((await request.formData()).get('id') ?? '');
		try {
			await purgeTrashItem(instance.path, id);
			forgetDiskBreakdown(instance.path);
			return { ok: true, message: 'Deleted for good.' };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Delete failed.' });
		}
	},

	emptyTrash: async ({ params }) => {
		const instance = requireInstance(params.id);
		try {
			const count = await emptyTrash(instance.path);
			forgetDiskBreakdown(instance.path);
			return { ok: true, message: `Emptied the trash (${count} item${count === 1 ? '' : 's'}).` };
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not empty the trash.' });
		}
	}
};
