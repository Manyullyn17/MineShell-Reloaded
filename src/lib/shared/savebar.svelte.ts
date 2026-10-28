import { tick } from 'svelte';
import { invalidateAll } from '$app/navigation';
import { actionMessage, postAction } from './forms.js';

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Entry = {
	label: string;
	/** What the form posted when it was last saved or loaded. */
	base: string;
	/** Its fields as they were then, for Discard. */
	fields: { el: Field; value: string; checked: boolean }[];
	/** Changed since then by the person (sticky until saved or discarded). */
	edited: boolean;
};

/** What a form would post, as text: "changed" is this differing from the saved one. Files are left out. */
function posted(form: HTMLFormElement): string {
	return JSON.stringify([...new FormData(form)].filter(([, v]) => typeof v === 'string'));
}

function fieldsOf(form: HTMLFormElement): Entry['fields'] {
	return [...form.elements]
		.filter((el): el is Field => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
		.map((el) => ({ el, value: el.value, checked: el instanceof HTMLInputElement && el.checked }));
}

const inPageOrder = (a: HTMLFormElement, b: HTMLFormElement) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

/**
 * One save bar for several settings forms, each posting to its own action
 * (MineShell settings). A form joins with `use:tracker.track={'Its section'}`;
 * it counts as changed while what it would post differs from what it posted
 * when last saved, which also catches changes a button makes (Back to the
 * defaults). Saving posts the changed forms in page order, the bodies taken
 * before any of them reloads the page, and stops at the first refusal; the
 * page's data is reloaded only once all went through, so a refused form keeps
 * its edits. Submitting a form (Enter) saves through the bar too; a button with
 * its own `formaction` (Send a test message) still posts at once.
 */
export class SaveTracker {
	#entries = new Map<HTMLFormElement, Entry>();
	/** Labels of the changed forms, in page order. */
	changed = $state<string[]>([]);
	/** Forms on the page now; no bar without any. */
	count = $state(0);
	saving = $state(false);
	message = $state<{ ok: boolean; message: string } | null>(null);

	#dirtyForms(): HTMLFormElement[] {
		return [...this.#entries].filter(([form, entry]) => posted(form) !== entry.base).map(([form]) => form).sort(inPageOrder);
	}

	check = () => {
		const dirty = this.#dirtyForms();
		for (const form of dirty) this.#entries.get(form)!.edited = true;
		this.changed = dirty.map((form) => this.#entries.get(form)!.label);
	};

	#rebase(form: HTMLFormElement) {
		const entry = this.#entries.get(form);
		if (!entry) return;
		// Fields that never show what is saved (a notification address) empty after a save.
		for (const el of form.querySelectorAll<HTMLInputElement>('[data-save-clear]')) el.value = '';
		entry.base = posted(form);
		entry.fields = fieldsOf(form);
		entry.edited = false;
	}

	/** After the page's data changed for another reason (an action elsewhere): forms nobody edited take it as saved. */
	async rebaseUnedited() {
		await tick();
		for (const [form, entry] of this.#entries) if (!entry.edited) this.#rebase(form);
		this.check();
	}

	track = (form: HTMLFormElement, label: string) => {
		this.#entries.set(form, { label, base: posted(form), fields: fieldsOf(form), edited: false });
		this.count = this.#entries.size;
		const later = () => setTimeout(this.check);
		const submit = (event: SubmitEvent) => {
			if (event.submitter?.hasAttribute('formaction')) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			void this.save();
		};
		form.addEventListener('input', this.check);
		form.addEventListener('change', this.check);
		form.addEventListener('click', later);
		// Capture: before the form's use:enhance listener on the same element.
		form.addEventListener('submit', submit, true);
		return {
			update: (next: string) => {
				const entry = this.#entries.get(form);
				if (entry) entry.label = next;
			},
			destroy: () => {
				form.removeEventListener('input', this.check);
				form.removeEventListener('change', this.check);
				form.removeEventListener('click', later);
				form.removeEventListener('submit', submit, true);
				this.#entries.delete(form);
				this.count = this.#entries.size;
				this.check();
			}
		};
	};

	async save() {
		const dirty = this.#dirtyForms();
		if (!dirty.length || this.saving) return;
		this.saving = true;
		this.message = null;
		const bodies = dirty.map((form) => ({ form, body: new FormData(form), label: this.#entries.get(form)!.label }));
		const done: string[] = [];
		try {
			for (const { form, body, label } of bodies) {
				const result = await postAction(form.action, body);
				if (result.type !== 'success') {
					this.message = { ok: false, message: `${label}: ${actionMessage(result, 'Could not save it.')}` };
					break;
				}
				done.push(actionMessage(result, 'Saved.'));
				this.#rebase(form);
			}
			if (done.length === bodies.length) {
				await invalidateAll();
				await tick();
				for (const { form } of bodies) this.#rebase(form);
				this.message = { ok: true, message: done.length === 1 ? done[0] : `Saved ${bodies.map((b) => b.label).join(', ')}.` };
			}
		} finally {
			this.saving = false;
			this.check();
		}
	}

	/** Puts the changed forms back as they were saved: through input events, so bound state follows. */
	async discard() {
		for (let pass = 0; pass < 2; pass++) {
			for (const form of this.#dirtyForms()) {
				for (const { el, value, checked } of this.#entries.get(form)!.fields) {
					if (!el.isConnected) continue;
					if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
						if (el.checked === checked) continue;
						el.checked = checked;
						el.dispatchEvent(new Event('change', { bubbles: true }));
					} else if (el.value !== value) {
						el.value = value;
						el.dispatchEvent(new Event('input', { bubbles: true }));
						el.dispatchEvent(new Event('change', { bubbles: true }));
					}
				}
			}
			// A choice put back can bring back fields it hid; the second pass fills those.
			await tick();
		}
		for (const [form, entry] of this.#entries) if (posted(form) === entry.base) entry.edited = false;
		this.check();
	}
}
