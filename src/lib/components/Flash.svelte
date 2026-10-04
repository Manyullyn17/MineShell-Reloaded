<script lang="ts">
	/** Renders the `form` object returned by an action, or an explicit message. */
	let {
		form = null,
		message = '',
		type = 'info'
	}: {
		form?: { ok?: boolean; message?: string } | null;
		message?: string;
		type?: 'success' | 'error' | 'info' | 'warning';
	} = $props();

	const text = $derived(form?.message ?? message);
	const tone = $derived(form ? (form.ok === false ? 'error' : 'success') : type);

	// `form` is only reset by SvelteKit on a real navigation, not by
	// refreshAll()'s periodic reload - so a page that polls its own load
	// function (like the instance overview) keeps re-showing e.g. "Starting."
	// long after it's stopped being true, until the person happens to switch
	// tabs. Errors stay until the next action; other tones clear themselves.
	let dismissed = $state(false);
	$effect(() => {
		dismissed = false;
		if (!text || tone === 'error') return;
		const timer = setTimeout(() => {
			dismissed = true;
		}, 6000);
		return () => clearTimeout(timer);
	});
</script>

{#if text && !dismissed}
	<div class="notice {tone}" role="status">
		<p>{text}</p>
	</div>
{/if}
