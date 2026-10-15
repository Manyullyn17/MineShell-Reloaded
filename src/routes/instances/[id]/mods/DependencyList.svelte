<script lang="ts" module>
	/** What a mod update or version change brings in and leaves behind (lib/server/modupdates.ts). */
	export type DependencyPlan = {
		install: { projectId: string; name: string; versionNumber: string; neededBy: string[] }[];
		unresolved: { name: string; neededBy: string[]; reason: string }[];
		conflicts: { name: string; fileName: string; declaredBy: string[] }[];
		unneeded: { fileName: string; name: string; neededBy: string[] }[];
	};
</script>

<script lang="ts">
	/** Goes inside the update's form: the unneeded ones are ticked `disableUnneeded` fields. */
	let { plan }: { plan: DependencyPlan } = $props();
</script>

{#if plan.install.length}
	<p class="small">Also installs what the new versions need:</p>
	<ul class="small deps">
		{#each plan.install as d (d.projectId)}
			<li><strong>{d.name}</strong> <span class="mono">{d.versionNumber}</span> <span class="muted">- for {d.neededBy.join(', ')}</span></li>
		{/each}
	</ul>
{/if}
{#if plan.unresolved.length}
	<ul class="small deps warn-text">
		{#each plan.unresolved as d (d.name)}
			<li>{d.name}, needed by {d.neededBy.join(', ')}, cannot be installed: {d.reason}.</li>
		{/each}
	</ul>
{/if}
{#if plan.conflicts.length}
	<ul class="small deps warn-text">
		{#each plan.conflicts as c (c.fileName)}
			<li>{c.declaredBy.join(', ')} declare{c.declaredBy.length === 1 ? 's' : ''} <strong>{c.name}</strong> incompatible; disable one of them if the server fails to start.</li>
		{/each}
	</ul>
{/if}
{#if plan.unneeded.length}
	<p class="small">No longer needed by anything here once updated (only the old version required them):</p>
	<ul class="small deps unneeded">
		{#each plan.unneeded as u (u.fileName)}
			<li>
				<label>
					<input type="checkbox" name="disableUnneeded" value={u.fileName} checked />
					Disable <strong>{u.name}</strong> <span class="muted">- was needed by {u.neededBy.join(', ')}</span>
				</label>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.deps {
		margin: 0 0 var(--space-3);
		padding: 0 0 0 1.2rem;
		overflow-y: auto;
	}

	.warn-text {
		color: var(--warning);
	}
</style>
