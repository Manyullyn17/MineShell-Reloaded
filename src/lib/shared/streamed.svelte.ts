/**
 * The value of a streamed load promise (one `load` returns without awaiting,
 * so the page opens at once), kept while the next one loads. An `{#await}`
 * block shows its pending branch again on every reload - a form action, the
 * header's invalidateAll - which blanked what it showed and lost its scroll.
 *
 * `key` says what the value is of: a value loaded for another key (another
 * log picked) is not `ready`, so the page shows its placeholder instead.
 */
export function streamed<T>(source: () => Promise<T> | T, key: () => string = () => '') {
	let loaded = $state.raw<{ key: string; value: T } | null>(null);
	let loading = $state(true);
	$effect(() => {
		const promise = source();
		const forKey = key();
		let live = true;
		loading = true;
		Promise.resolve(promise).then(
			(value) => {
				if (!live) return;
				loaded = { key: forKey, value };
				loading = false;
			},
			() => {
				if (live) loading = false;
			}
		);
		return () => {
			live = false;
		};
	});
	return {
		/** A value for the current key has arrived (it may be reloading behind it). */
		get ready() {
			return loaded !== null && loaded.key === key();
		},
		/** The newest value that arrived, whatever its key; undefined before the first. */
		get value() {
			return loaded?.value;
		},
		get loading() {
			return loading;
		}
	};
}
