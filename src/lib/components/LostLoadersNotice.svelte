<script lang="ts">
	/**
	 * A data pack loader leaving with data packs in its folders (datapackloaders.ts,
	 * lostDatapackLoaders): the pack change's and the version move's warning, and the tick that
	 * copies them to where the loader taking over reads (`copyLostDatapacks` on the form).
	 */
	type Lost = {
		mod: string;
		fileName: string;
		packs: string[];
		worldgen: boolean;
		takenOverBy: { mod: string; sameMod: boolean; folder: string | null } | null;
	};
	let {
		lostLoaders,
		worldFolder,
		during,
		target
	}: {
		lostLoaders: Lost[];
		/** The active world's folder, where a pack nothing reads any more can go. */
		worldFolder: string;
		/** A modpack version change ships its own files; a version move only moves mods. */
		during: 'change' | 'move';
		/** The Minecraft version moved to (`move`). */
		target?: string;
	} = $props();

	const after = $derived(during === 'change' ? 'after the change' : 'after the move');
</script>

{#each lostLoaders as lost (lost.fileName)}
	{@const one = lost.packs.length === 1}
	{@const by = lost.takenOverBy}
	{@const count = one ? 'a data pack' : `${lost.packs.length} data packs`}
	{@const notShipped = during === 'change' ? ' the installed version did not ship' : ''}
	<div class="notice warning small">
		<p>
			{#if by?.sameMod}
				<strong>{during === 'change' ? `The new version's ${lost.mod}` : `${lost.mod}'s build for ${target}`} reads another folder</strong>{by.folder
					? ` (${by.folder})`
					: ''}: {count}{notShipped}
				{one ? 'is' : 'are'} in one it no longer reads.
			{:else if by}
				<strong>{during === 'change' ? 'The new version loads' : 'After the move, the server loads'} data packs with {by.mod} instead of {lost.mod}</strong>{by.folder
					? `, from ${by.folder}`
					: ''}:
				{count}{notShipped}
				{one ? 'is' : 'are'} in {lost.mod}'s folder.
			{:else}
				<strong>{during === 'change' ? `The new version drops ${lost.mod}` : `The move disables ${lost.mod}`}</strong>, which loads {count}{notShipped}.
			{/if}
			{#if !by?.folder}
				{one ? 'It stays' : 'They stay'} where {one ? 'it is' : 'they are'}, but nothing loads {one ? 'it' : 'them'}
				{after}: move {one ? 'it' : 'them'} into <code>{worldFolder}/datapacks</code>{by ? '' : `, or add ${lost.mod} back`}.
			{/if}
			{#if lost.worldgen}
				One adds world generation: if the world has loaded it, the world may not load without it, so {by?.folder
					? 'keep it loaded'
					: 'move it before the next start'}.
			{/if}
		</p>
		<ul class="files">
			{#each lost.packs as f (f)}<li>{f}</li>{/each}
		</ul>
	</div>
{/each}
{#if lostLoaders.some((l) => l.takenOverBy?.folder)}
	{@const single = lostLoaders.length === 1 && lostLoaders[0].packs.length === 1}
	<div class="check">
		<input id="copy-lost-datapacks" type="checkbox" name="copyLostDatapacks" checked />
		<label for="copy-lost-datapacks">
			Copy {single ? 'it' : 'them'} to where {lostLoaders.length === 1 ? lostLoaders[0].takenOverBy?.mod : 'the new version'} reads data packs,
			{after}. The old {single ? 'copy stays' : 'copies stay'}, read by nothing; data packs from Add mods are moved instead, so their
			updates follow.
		</label>
	</div>
{/if}

<style>
	/* A list of paths, as the pack change's file lists. */
	.files {
		padding-left: 1.2rem;
		margin: var(--space-2) 0;
		max-height: 16rem;
		overflow-y: auto;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		list-style: none;
		overflow-wrap: anywhere;
	}
</style>
