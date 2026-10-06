<script lang="ts">
	/**
	 * Shown inside a form whose submission came back with a missing Java. Its
	 * buttons submit the same form again with `downloadJava` set, so the
	 * operation downloads the runtime as its first step and carries on.
	 */
	let {
		form,
		action
	}: {
		form: { javaMissing?: { major: number; action: string }; [key: string]: unknown } | null | undefined;
		/** Which form this one is (the action's name), since a page has several. */
		action: string;
	} = $props();

	const missing = $derived(form?.javaMissing?.action === action ? form.javaMissing : null);
</script>

{#if missing}
	<div class="notice warning java-prompt">
		<p>Java {missing.major} is not installed. Download it, then continue:</p>
		<div class="button-row">
			<button class="button-primary" type="submit" name="downloadJava" value="temurin">
				Eclipse Temurin {missing.major}
			</button>
			<button type="submit" name="downloadJava" value="zulu">Azul Zulu {missing.major}</button>
		</div>
		<p class="hint">
			Kept in MineShell's data folder and matched automatically from then on. Downloaded runtimes are listed
			in <a href="/settings">MineShell settings</a>.
		</p>
	</div>
{/if}

<style>
	.java-prompt {
		margin: var(--space-3) 0;
	}

	.java-prompt .button-row {
		margin: var(--space-2) 0;
	}
</style>
