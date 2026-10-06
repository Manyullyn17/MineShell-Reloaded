<script lang="ts">
	/**
	 * The MineShell cube: a grass top over two faces, a list on one and a
	 * prompt on the other. Drawn rather than an image so it follows the theme:
	 * the outline and prompt take the text colour, the grass and list the accent.
	 */
	let { size = 22 }: { size?: number } = $props();
</script>

<svg class="mark" viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
	<!-- Grass top, with the dirt notches along its lower edges. -->
	<path
		class="accent"
		d="M50 3 L93 25 L77 33 L72 30 L64 34 L64 40 L50 47 L36 40 L36 34 L28 30 L23 33 L7 25 Z"
	/>
	<path
		class="line"
		d="M8 29 L50 51 L92 29 M8 29 V73 L50 95 L92 73 V29 M50 51 V95"
		fill="none"
		stroke-width="6"
		stroke-linejoin="round"
		stroke-linecap="round"
	/>
	<!-- The list on the left face. -->
	<g class="accent">
		<circle cx="17" cy="45" r="3.4" />
		<circle cx="17" cy="56" r="3.4" />
		<circle cx="17" cy="67" r="3.4" />
	</g>
	<path
		class="accent-line"
		d="M25 48 L40 56 M25 59 L40 67 M25 70 L40 78"
		fill="none"
		stroke-width="5"
		stroke-linecap="round"
	/>
	<!-- The prompt on the right face. -->
	<path
		class="line"
		d="M60 61 L69 64 L61 76 M71 75 L82 69"
		fill="none"
		stroke-width="5"
		stroke-linejoin="round"
		stroke-linecap="round"
	/>
</svg>

<style>
	.mark {
		display: block;
		flex: none;
	}

	.accent {
		fill: var(--accent);
	}

	.accent-line {
		stroke: var(--accent);
	}

	.line {
		stroke: var(--text);
	}
</style>
