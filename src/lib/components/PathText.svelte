<script lang="ts">
	/**
	 * A file path that wraps at its slashes: a break opportunity (<wbr>) after
	 * each "/", so a long path breaks between folders rather than inside one.
	 * A single folder name wider than the line still breaks as a last resort.
	 */
	let { path }: { path: string } = $props();
	const parts = $derived(path.split('/'));
</script>

<span class="path">{#each parts as part, i (i)}{part}{#if i < parts.length - 1}/<wbr />{/if}{/each}</span>

<style>
	.path {
		overflow-wrap: break-word;
	}
</style>
