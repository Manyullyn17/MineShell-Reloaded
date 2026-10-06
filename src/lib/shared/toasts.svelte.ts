/**
 * Short messages in the corner of the screen: the result of a save, a task
 * that finished. They can be closed; anything but an error also closes
 * itself, so a message never outstays what it reports. Shown by
 * `NotificationCenter`, which also turns finished tasks into toasts.
 *
 * Only ever filled from the browser (event handlers, the task stream), so the
 * module-level state is never shared between server-side renders.
 */

export type ToastTone = 'ok' | 'error' | 'info';
export type Toast = { id: string; tone: ToastTone; message: string; title?: string; href?: string };

/** How long a toast that is not an error stays up. */
export const TOAST_MS = 8000;

export const toasts = $state<Toast[]>([]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let next = 0;

export function toast(t: Omit<Toast, 'id'> & { id?: string }): string {
	const id = t.id ?? `toast-${++next}`;
	dismissToast(id);
	toasts.push({ ...t, id });
	if (t.tone !== 'error') timers.set(id, setTimeout(() => dismissToast(id), TOAST_MS));
	return id;
}

export function dismissToast(id: string): void {
	clearTimeout(timers.get(id));
	timers.delete(id);
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
}

/** Stops a toast closing itself while the pointer is over it; `resume` restarts the full wait. */
export function holdToast(id: string): void {
	clearTimeout(timers.get(id));
	timers.delete(id);
}

export function resumeToast(id: string): void {
	const t = toasts.find((x) => x.id === id);
	if (t && t.tone !== 'error' && !timers.has(id)) timers.set(id, setTimeout(() => dismissToast(id), TOAST_MS));
}
