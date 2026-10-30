import type { Environment } from 'vitest/runtime';

/**
 * For `*.svelte.test.ts`: compiled as browser code, where `$effect` and `$derived` run
 * (as server code they are left out), with no DOM - runes need none.
 */
export default <Environment>{
	name: 'runes',
	viteEnvironment: 'client',
	setup() {
		return { teardown() {} };
	}
};
