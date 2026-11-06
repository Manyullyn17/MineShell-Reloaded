import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accepts, DRAG_GONE_MS, dropzone, type DropzoneOptions } from './dropzone';

const file = (name: string, type = '') => new File(['x'], name, { type });

describe('which dropped files an input takes', () => {
	it('matches extensions, MIME types and wildcards as the browser does', () => {
		expect(accepts('.zip,application/zip', file('World.ZIP'))).toBe(true);
		expect(accepts('.zip,application/zip', file('world', 'application/zip'))).toBe(true);
		expect(accepts('.zip,application/zip', file('photo.png', 'image/png'))).toBe(false);
		expect(accepts('image/*', file('icon.webp', 'image/webp'))).toBe(true);
		expect(accepts('.mrpack,.zip', file('pack.mrpack'))).toBe(true);
		expect(accepts('.jar', file('mod.jar.disabled'))).toBe(false);
	});

	it('takes anything when the input names nothing', () => {
		expect(accepts('', file('notes.txt'))).toBe(true);
	});
});

describe('the outline while files are dragged over a zone', () => {
	/** Just what the action touches of an element and the window (the tests run without a page). */
	const zone = (options: DropzoneOptions = {}) => {
		const node = Object.assign(new EventTarget(), {
			classes: new Set<string>(),
			dataset: {} as Record<string, string>,
			querySelector: () => null
		});
		const classList = {
			add: (c: string) => node.classes.add(c),
			remove: (c: string) => node.classes.delete(c),
			toggle: (c: string, on: boolean) => (on ? node.classes.add(c) : node.classes.delete(c))
		};
		const element = Object.assign(node, { classList }) as unknown as HTMLElement & { classes: Set<string> };
		const action = dropzone(element, options);
		return { element, action };
	};
	const drag = (type: string) => Object.assign(new Event(type), { dataTransfer: { types: ['Files'], dropEffect: 'none' } });

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('window', new EventTarget());
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('goes when a drag ends elsewhere without leaving the zone (cancelled, taken back to the file manager)', () => {
		const { element, action } = zone();
		element.dispatchEvent(drag('dragenter'));
		expect(element.classes.has('dropping')).toBe(true);
		// Held still over the zone: dragover keeps coming, the outline stays.
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(300);
			element.dispatchEvent(drag('dragover'));
		}
		expect(element.classes.has('dropping')).toBe(true);
		// No dragleave and no drop: the drag just stops reaching the page.
		vi.advanceTimersByTime(DRAG_GONE_MS);
		expect(element.classes.has('dropping')).toBe(false);
		action?.destroy?.();
	});

	// The Data packs tab: a section's drop picks that section's folder, and the upload the
	// input's change starts reads the form, so the folder has to be in place by then.
	it('runs `before` ahead of the input being filled', () => {
		vi.stubGlobal('DataTransfer', class { items = { add: () => {} }; files = []; });
		const order: string[] = [];
		const input = {
			accept: '.zip',
			multiple: true,
			disabled: false,
			set files(_: unknown) {
				order.push('filled');
			},
			dispatchEvent: (event: Event) => order.push(event.type)
		} as unknown as HTMLInputElement;
		const { element } = zone({ input, before: () => order.push('before') });
		const dataTransfer = { types: ['Files'], items: [], files: [file('pack.zip')] };
		element.dispatchEvent(Object.assign(new Event('drop'), { dataTransfer }));
		expect(order).toEqual(['before', 'filled', 'input', 'change']);
		vi.unstubAllGlobals();
	});

	it('does not run `before` for files the input refuses', () => {
		vi.stubGlobal('DataTransfer', class { items = { add: () => {} }; files = []; });
		const before = vi.fn();
		const input = { accept: '.zip', multiple: true, disabled: false, dispatchEvent: () => true } as unknown as HTMLInputElement;
		const { element } = zone({ input, before });
		element.dispatchEvent(Object.assign(new Event('drop'), { dataTransfer: { types: ['Files'], items: [], files: [file('notes.txt')] } }));
		expect(before).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('goes at once on a dragleave out of the zone, as before', () => {
		const { element, action } = zone();
		element.dispatchEvent(drag('dragenter'));
		element.dispatchEvent(drag('dragleave'));
		expect(element.classes.has('dropping')).toBe(false);
		action?.destroy?.();
	});
});
