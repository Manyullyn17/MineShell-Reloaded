import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const viteConfig = fs.readFileSync('vite.config.ts', 'utf8');

/**
 * Settings that live in configuration, not code, so nothing else would
 * notice them going missing.
 */
describe('security settings in the configuration', () => {
	// The dev server listens on the network, and SvelteKit's generated env module
	// holds every private variable's value (the CurseForge key): it was served to anyone.
	it("keeps the dev server from serving SvelteKit's env module", () => {
		expect(viteConfig).toMatch(/deny:\s*\[[^\]]*'\.env'/);
		expect(viteConfig).toContain("'**/generated/dev/env/**'");
	});
});
