import { untrack } from 'svelte';

/**
 * Opens something for `key` (a stream for a server's id) and opens it again, after
 * closing the last, only when the key's value changes. A component's effect that read
 * the prop itself ran again whenever the page's data was reloaded, even with the same
 * id: a starting server's tabs reload every 3 s, and the console emptied and reopened
 * its stream each time (0.30.0 to 0.33.15). Call it while the component initialises.
 */
export function followKey(key: () => string, open: (key: string) => () => void): void {
	const current = $derived(key());
	$effect(() => {
		const value = current;
		return untrack(() => open(value));
	});
}
