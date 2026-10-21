import type { Component } from 'svelte';
import { render } from 'svelte/server';

/**
 * What a browser would post for the fields a component renders, for checking a
 * form round trip: render the fields from saved values, post exactly what they
 * send, and nothing should change. Unchecked boxes and radios, disabled
 * fields and buttons are left out, as a browser leaves them out.
 *
 *   const fields = formFields(RestartFields, { values: instance });
 *   await post(actions.restarts, { params: { id }, fields });
 *
 * Reads Svelte's server-rendered markup only (double-quoted attributes,
 * `checked=""`/`selected=""`), not HTML in general.
 */
export function formFields<Props extends Record<string, unknown>>(component: Component<Props>, props: Props): Record<string, string[]> {
	return fieldsOf(render(component as Component<Record<string, unknown>>, { props }).body);
}

export function fieldsOf(html: string): Record<string, string[]> {
	const fields: Record<string, string[]> = {};
	const add = (name: string, value: string) => (fields[name] ??= []).push(value);
	const markup = html.replace(/<!--[\s\S]*?-->/g, '');
	const tag = /<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g;
	for (const m of markup.matchAll(tag)) {
		const attrs = attributes(m[1] ?? m[2] ?? m[4]);
		const name = attrs.name;
		if (name === undefined || 'disabled' in attrs) continue;
		if (m[1] !== undefined) {
			const type = (attrs.type ?? 'text').toLowerCase();
			if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
			if ((type === 'checkbox' || type === 'radio') && !('checked' in attrs)) continue;
			add(name, attrs.value ?? (type === 'checkbox' || type === 'radio' ? 'on' : ''));
		} else if (m[2] !== undefined) {
			const options = [...m[3].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((o) => ({
				attrs: attributes(o[1]),
				text: decode(o[2].replace(/<[^>]*>/g, '').trim())
			}));
			const chosen = 'multiple' in attrs ? options.filter((o) => 'selected' in o.attrs) : [options.find((o) => 'selected' in o.attrs) ?? options[0]];
			for (const o of chosen) if (o) add(name, o.attrs.value ?? o.text);
		} else {
			add(name, decode(m[5]));
		}
	}
	return fields;
}

function attributes(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const a of source.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? '');
	return attrs;
}

function decode(text: string): string {
	return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
