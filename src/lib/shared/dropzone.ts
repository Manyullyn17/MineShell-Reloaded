import type { Action } from 'svelte/action';

/**
 * Files dropped onto one part of a page: the part that is about them (the
 * file list, the "replace the world" section), outlined while files are
 * dragged over it - not the whole window.
 *
 * By default the dropped files go into a file input, `input` or the first
 * one inside the zone, followed by a change event, so the upload does
 * exactly what picking the files would: one file for a single input, only
 * files its `accept` allows (others are refused with a note on the zone).
 * `onDrop` takes over instead (the Files browser, which uploads folders).
 *
 * While any zone is on the page, a file dropped anywhere else is ignored
 * rather than opened by the browser in place of the page.
 */
export type DropzoneOptions = {
	/** The input to fill; else the first file input inside the zone. */
	input?: HTMLInputElement | null;
	/** Handles the drop itself instead of filling an input. */
	onDrop?: (event: DragEvent) => void;
	disabled?: boolean;
	/** Shown on the zone while dragging, e.g. "Drop to upload into world/". */
	label?: string;
};

const isFileDrag = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

/** Whether `file` passes an input's accept list (".zip", "image/*", "application/zip"). */
export function accepts(accept: string, file: File): boolean {
	const rules = accept
		.split(',')
		.map((r) => r.trim().toLowerCase())
		.filter(Boolean);
	if (!rules.length) return true;
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	return rules.some((rule) =>
		rule.startsWith('.') ? name.endsWith(rule) : rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) : type === rule
	);
}

// The guard against drops outside every zone: installed with the first zone, removed with the last.
let zones = 0;
const guard = (event: DragEvent) => {
	if (!isFileDrag(event) || event.defaultPrevented) return;
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
};

export const dropzone: Action<HTMLElement, DropzoneOptions | undefined> = (node, initial) => {
	let options: DropzoneOptions = initial ?? {};
	let depth = 0;
	let refusedTimer: ReturnType<typeof setTimeout> | undefined;
	node.classList.add('dropzone');

	const label = () => {
		const input = target();
		if (options.label) return options.label;
		if (input?.accept) return `Drop ${input.multiple ? 'files' : 'a file'} here (${input.accept.split(',').filter((r) => r.trim().startsWith('.')).join(', ') || input.accept})`;
		return 'Drop here';
	};
	const target = () => options.input ?? node.querySelector<HTMLInputElement>('input[type="file"]');
	const set = (dropping: boolean) => {
		node.classList.toggle('dropping', dropping);
		if (dropping) node.dataset.dropLabel = label();
	};
	const refuse = (message: string) => {
		node.classList.add('drop-refused');
		node.dataset.dropLabel = message;
		clearTimeout(refusedTimer);
		refusedTimer = setTimeout(() => node.classList.remove('drop-refused'), 2500);
	};

	const enter = (event: DragEvent) => {
		if (!isFileDrag(event) || options.disabled) return;
		event.preventDefault();
		if (depth++ === 0) set(true);
	};
	const over = (event: DragEvent) => {
		if (!isFileDrag(event) || options.disabled) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	};
	const leave = (event: DragEvent) => {
		if (!isFileDrag(event) || options.disabled) return;
		depth = Math.max(0, depth - 1);
		if (depth === 0) set(false);
	};
	const drop = (event: DragEvent) => {
		if (!isFileDrag(event) || options.disabled) return;
		event.preventDefault();
		depth = 0;
		set(false);
		if (options.onDrop) return options.onDrop(event);
		const input = target();
		if (!input || input.disabled || !event.dataTransfer) return;
		// Folders come through as entries without a file; only files go into an input.
		const items = [...event.dataTransfer.items];
		const files = [...event.dataTransfer.files].filter((_, i) => items[i]?.webkitGetAsEntry?.()?.isFile ?? true);
		const fitting = files.filter((f) => accepts(input.accept, f));
		if (!fitting.length) return refuse(files.length ? `Not a ${input.accept.split(',')[0].trim()} file` : 'Only files, not folders');
		const picked = new DataTransfer();
		for (const file of input.multiple ? fitting : fitting.slice(0, 1)) picked.items.add(file);
		input.files = picked.files;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
		if (fitting.length < files.length) refuse(`${files.length - fitting.length} file(s) skipped: not ${input.accept}`);
	};

	node.addEventListener('dragenter', enter);
	node.addEventListener('dragover', over);
	node.addEventListener('dragleave', leave);
	node.addEventListener('drop', drop);
	if (zones++ === 0) {
		window.addEventListener('dragover', guard);
		window.addEventListener('drop', guard);
	}

	return {
		update(next) {
			options = next ?? {};
			if (options.disabled) {
				depth = 0;
				set(false);
			}
		},
		destroy() {
			clearTimeout(refusedTimer);
			node.removeEventListener('dragenter', enter);
			node.removeEventListener('dragover', over);
			node.removeEventListener('dragleave', leave);
			node.removeEventListener('drop', drop);
			if (--zones === 0) {
				window.removeEventListener('dragover', guard);
				window.removeEventListener('drop', guard);
			}
		}
	};
};
