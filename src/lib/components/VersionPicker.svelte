<script lang="ts">
	import { versionGroups, type VersionOption } from '#lib/shared/versionpicker.js';

	/**
	 * A picker for the long version lists (Minecraft, loader builds) in place of a `<select>`,
	 * whose popup the browser draws as tall as the screen (Firefox). Typing filters the list,
	 * which scrolls within a limited height; arrow keys, Enter and Escape work as in a select.
	 * Releases are listed apart from betas and snapshots when a list has both; an option with
	 * an empty value ("Latest (...)") stays on top. The list is fixed to the window, as
	 * RowMenu's is, so a box's overflow does not cut it off. Short lists stay native selects.
	 */
	let {
		id,
		name,
		value = $bindable(''),
		options,
		disabled = false,
		busy = false,
		ariaLabel,
		empty = 'Nothing to pick',
		onchange
	}: {
		id: string;
		/** Set to submit the value with a form, as a select's name would. */
		name?: string;
		value?: string;
		options: VersionOption[];
		disabled?: boolean;
		busy?: boolean;
		ariaLabel?: string;
		/** Shown when there are no options (still loading, none for this version). */
		empty?: string;
		onchange?: (value: string) => void;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let active = $state(0);
	let input = $state<HTMLInputElement | null>(null);
	let list = $state<HTMLUListElement | null>(null);
	let place = $state({ top: 0, left: 0, width: 0, maxHeight: 0, up: false });

	const listId = $derived(`${id}-list`);
	const selected = $derived(options.find((o) => o.value === value));
	const shown = $derived(versionGroups(options, query));
	const flat = $derived(shown.flatMap((g) => g.options));

	/** Under the field, or above it when there is more room there. */
	function follow() {
		if (!input) return;
		const r = input.getBoundingClientRect();
		const below = window.innerHeight - r.bottom - 12;
		const above = r.top - 12;
		const up = below < 200 && above > below;
		place = { top: up ? r.top - 4 : r.bottom + 4, left: r.left, width: r.width, maxHeight: Math.min(288, up ? above : below), up };
	}

	function show() {
		if (open || disabled) return;
		query = '';
		follow();
		open = true;
		active = Math.max(
			0,
			flat.findIndex((o) => o.value === value)
		);
		requestAnimationFrame(reveal);
	}

	function close() {
		open = false;
		query = '';
	}

	function pick(option: VersionOption) {
		const changed = option.value !== value;
		value = option.value;
		close();
		if (changed) onchange?.(option.value);
	}

	function reveal() {
		list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	function move(by: number) {
		if (!flat.length) return;
		active = (active + by + flat.length) % flat.length;
		requestAnimationFrame(reveal);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!open) show();
			else move(e.key === 'ArrowDown' ? 1 : -1);
		} else if (e.key === 'PageDown' || e.key === 'PageUp') {
			if (!open) return;
			e.preventDefault();
			move(e.key === 'PageDown' ? 8 : -8);
		} else if (e.key === 'Enter') {
			if (!open) return;
			// Picking, not submitting the form around it.
			e.preventDefault();
			if (flat[active]) pick(flat[active]);
		} else if (e.key === 'Escape') {
			if (open) {
				e.preventDefault();
				close();
			}
		} else if (e.key === 'Tab') {
			close();
		}
	}

	// The field is focused with its text selected, so typing replaces the picked label.
	function oninput(e: Event) {
		if (!open) show();
		query = (e.currentTarget as HTMLInputElement).value;
		active = 0;
		requestAnimationFrame(reveal);
	}

	// Follows the field while open, whatever scrolls (the window or a box around it).
	$effect(() => {
		if (!open) return;
		const onScroll = (e: Event) => {
			if (e.target !== list) follow();
		};
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', follow);
		return () => {
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', follow);
		};
	});
</script>

<span class="version-picker">
	<input
		{id}
		bind:this={input}
		role="combobox"
		autocomplete="off"
		spellcheck="false"
		aria-label={ariaLabel}
		aria-autocomplete="list"
		aria-expanded={open}
		aria-controls={listId}
		aria-activedescendant={open && flat[active] ? `${id}-option-${active}` : undefined}
		aria-busy={busy}
		{disabled}
		value={open ? query : (selected?.label ?? (options.length ? value : empty))}
		placeholder={open ? (selected?.label ?? 'Type to filter') : undefined}
		onclick={show}
		onfocus={() => input?.select()}
		{onkeydown}
		{oninput}
		onblur={close}
	/>
	<span class="chevron" aria-hidden="true"></span>
	{#if name}<input type="hidden" {name} {value} />{/if}
	{#if open}
		<!-- Pressing an option must not take the focus from the field first (its blur closes the list). -->
		<ul
			class="list"
			class:up={place.up}
			id={listId}
			role="listbox"
			bind:this={list}
			style:top="{place.top}px"
			style:left="{place.left}px"
			style:min-width="{place.width}px"
			style:max-height="{place.maxHeight}px"
			onmousedown={(e) => e.preventDefault()}
		>
			{#each shown as group, g (group.heading ?? `group-${g}`)}
				{#if group.heading}<li class="heading" role="presentation">{group.heading}</li>{/if}
				{#each group.options as option (option.value)}
					{@const index = flat.indexOf(option)}
					<!-- The keys are the field's: it moves through the options (aria-activedescendant), as a select does. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id="{id}-option-{index}"
						role="option"
						data-index={index}
						aria-selected={option.value === value}
						class:active={index === active}
						onclick={() => pick(option)}
						onmousemove={() => (active = index)}
					>
						{option.label}
					</li>
				{/each}
			{:else}
				<li class="none" role="presentation">{options.length ? `No version matches "${query.trim()}"` : empty}</li>
			{/each}
		</ul>
	{/if}
</span>

<style>
	.version-picker {
		position: relative;
		display: block;
		min-width: 0;
	}

	/* As tall as a select beside it (MigratePanel's loader). */
	.version-picker > input {
		line-height: 1.3;
		padding-right: 1.8rem;
		cursor: default;
		text-overflow: ellipsis;
	}

	.version-picker > input:focus {
		cursor: text;
	}

	.chevron {
		position: absolute;
		right: 0.7rem;
		top: 50%;
		width: 0.4rem;
		height: 0.4rem;
		border-right: 1.5px solid var(--text-muted);
		border-bottom: 1.5px solid var(--text-muted);
		transform: translateY(-70%) rotate(45deg);
		pointer-events: none;
	}

	.list {
		position: fixed;
		z-index: 31;
		max-width: calc(100vw - 1rem);
		overflow-y: auto;
		overscroll-behavior: contain;
		margin: 0;
		padding: 4px;
		list-style: none;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
		font-size: 0.92rem;
	}

	.list.up {
		transform: translateY(-100%);
	}

	li[role='option'] {
		padding: 0.35rem 0.6rem;
		border-radius: calc(var(--radius) - 2px);
		cursor: pointer;
		overflow-wrap: anywhere;
	}

	li.active {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
	}

	li[aria-selected='true'] {
		font-weight: 600;
	}

	.heading {
		padding: 0.5rem 0.6rem 0.2rem;
		font-size: 0.78rem;
		color: var(--text-faint);
	}

	.none {
		padding: 0.45rem 0.6rem;
		color: var(--text-muted);
	}

	@media (pointer: coarse) {
		li[role='option'] {
			padding: 0.6rem;
		}
	}
</style>
