<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import SettingsSection from '#lib/components/SettingsSection.svelte';
	import { EVERY_MINUTES } from '#lib/shared/presets.js';
	import type { PageData } from './$types';

	let { commands, editable }: { commands: PageData['scheduledCommands']; editable: boolean } = $props();

	let commandMode = $state<'interval' | 'daily'>('interval');
	const formatTime = (at: number) =>
		new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
</script>

<SettingsSection tab="automation" title="Scheduled commands" {editable} description="Console commands run on a schedule while the server is running.">
	<div class="table-box commands">
		{#if commands.length}
			<table>
				<thead>
					<tr><th>Command</th><th>When</th><th>Next</th><th>Last run</th><th><span class="visually-hidden">Actions</span></th></tr>
				</thead>
				<tbody>
					{#each commands as c (c.id)}
						<tr class:paused={!c.enabled}>
							<td class="mono small wrap">{c.command}</td>
							<td class="small nowrap">
								{c.everyMinutes
									? c.everyMinutes % 60 === 0
										? `every ${c.everyMinutes / 60} h`
										: `every ${c.everyMinutes} min`
									: `daily at ${c.dailyTime}`}
							</td>
							<td class="small nowrap">{c.enabled && c.nextAt ? formatTime(c.nextAt) : 'paused'}</td>
							<td class="small">
								{#if c.lastRunAt}
									{formatTime(c.lastRunAt)}
									<div class="faint mono wrap" class:warn-text={c.lastResult?.startsWith('Failed')}>{c.lastResult}</div>
								{:else}
									<span class="faint">never</span>
								{/if}
							</td>
							<td class="right nowrap">
								<form method="POST" action="?/toggleCommand" use:enhance class="inline">
									<input type="hidden" name="id" value={c.id} />
									<input type="hidden" name="enabled" value={String(!c.enabled)} />
									<button class="button-quiet" type="submit">{c.enabled ? 'Pause' : 'Resume'}</button>
								</form>
								<form method="POST" action="?/removeCommand" use:enhance class="inline">
									<input type="hidden" name="id" value={c.id} />
									<button class="button-quiet" type="submit">Remove</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
		<form method="POST" action="?/addCommand" use:enhance class="add-command">
			<input name="command" class="mono grow" placeholder="say Remember to vote!" aria-label="Command" required />
			<select name="mode" bind:value={commandMode} aria-label="When">
				<option value="interval">Repeating</option>
				<option value="daily">Daily at</option>
			</select>
			{#if commandMode === 'daily'}
				<input name="dailyTime" type="time" value="04:00" aria-label="Time of day" required />
			{:else}
				<select name="everyMinutes" value="60" aria-label="How often">
					{#each EVERY_MINUTES as p (p.value)}
						<option value={String(p.value)}>{p.label}</option>
					{/each}
				</select>
			{/if}
			<button type="submit">Add</button>
		</form>
	</div>
	<p class="faint small after">
		Added, paused and removed straight away; these don't wait for Save. To pre-generate only at night, schedule
		<code>chunky continue</code> and <code>chunky pause</code>.
	</p>
</SettingsSection>

<style>
	.commands {
		margin-top: 0.9rem;
	}

	.commands .paused td {
		opacity: 0.6;
	}

	.commands form.inline {
		display: inline;
	}

	.add-command {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: color-mix(in srgb, var(--bg-sunken) 40%, var(--panel));
		border-top: 1px solid var(--line);
	}

	.add-command > * {
		width: auto;
	}

	.add-command .grow {
		flex: 1 1 14rem;
		margin: 0;
	}

	.after {
		margin: var(--space-2) 0 0;
	}

	.right {
		text-align: right;
	}

	.wrap {
		overflow-wrap: anywhere;
	}

	.warn-text {
		color: var(--warning);
	}
</style>
