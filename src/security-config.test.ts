import crypto from 'node:crypto';
import fs from 'node:fs';
import { compile } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

const viteConfig = fs.readFileSync('vite.config.ts', 'utf8');

/**
 * Settings that live in configuration, not code, so nothing else would
 * notice them going missing.
 */
describe('security settings in the configuration', () => {
	// Text from outside (mod descriptions, player names, log lines) that got past
	// escaping would otherwise run as the signed-in account.
	it("lets only MineShell's own scripts run in its pages", () => {
		expect(viteConfig).toMatch(/csp:\s*\{[\s\S]*?'script-src':\s*\['self',/);
		expect(viteConfig).toMatch(/'object-src':\s*\['none'\]/);
		// An inline script without Kit's nonce would be refused, and the theme would flash.
		const html = fs.readFileSync('src/app.html', 'utf8');
		const scripts = html.match(/<script\b[^>]*>/g) ?? [];
		expect(scripts.length).toBeGreaterThan(0);
		for (const tag of scripts) expect(tag).toContain('nonce="%sveltekit.nonce%"');
	});

	// Svelte renders `onerror="..."` on an <img> with an error handler, for hydration to
	// replay an error from before it; refused, a mod icon that failed early stayed broken.
	it("allows the one inline handler Svelte renders, by its hash, and nothing else inline", () => {
		const code = compile('<img src="x" alt="" onerror={() => {}} />', { generate: 'server' }).js.code;
		const handler = code.match(/onerror=\\?"([^"\\]*)/)![1];
		const hash = crypto.createHash('sha256').update(handler).digest('base64');
		const scriptSrc = viteConfig.match(/'script-src':\s*\[([^\]]*)\]/)![1];
		expect(scriptSrc.split(',').map((s) => s.trim())).toEqual(["'self'", "'unsafe-hashes'", `'sha256-${hash}'`]);
	});

	// The dev server listens on the network, and SvelteKit's generated env module
	// holds every private variable's value (the CurseForge key): it was served to anyone.
	it("keeps the dev server from serving SvelteKit's env module", () => {
		expect(viteConfig).toMatch(/deny:\s*\[[^\]]*'\.env'/);
		expect(viteConfig).toContain("'**/generated/dev/env/**'");
	});
});
