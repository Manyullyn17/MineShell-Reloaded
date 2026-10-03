<script lang="ts">
	/** Console buffer fields, shared by an instance's settings and the new-server defaults. */
	type ConsoleValues = { consoleBacklogLines: number; consoleBufferLines: number };
	let { values = $bindable() }: { values: ConsoleValues } = $props();
</script>

<div class="grid-2">
	<div class="field">
		<label for="consoleBacklogLines">History loaded on connect</label>
		<input id="consoleBacklogLines" name="consoleBacklogLines" type="number" min="0" max="10000" bind:value={values.consoleBacklogLines} />
	</div>
	<div class="field">
		<label for="consoleBufferLines">Lines kept in the browser</label>
		<input id="consoleBufferLines" name="consoleBufferLines" type="number" min="100" max="100000" bind:value={values.consoleBufferLines} />
		<p class="hint">
			{values.consoleBufferLines > 20000
				? 'Above about 20,000 lines the console gets sluggish in most browsers.'
				: 'Older lines drop off once this is reached.'}
		</p>
	</div>
</div>
