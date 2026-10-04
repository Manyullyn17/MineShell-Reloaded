import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Under Vitest, env files come from tests/env (which has none; see also
// env.dir in the sveltekit() options below), so the real .env - and with it the real
// MINESHELL_DATA - can never reach a test run. SvelteKit builds $env once,
// from this process, while the config loads, so the throwaway data directory
// has to be chosen here; the test workers inherit it and tests/setup.ts
// verifies it before any test runs.
const testing = Boolean(process.env.VITEST);
if (testing) {
  process.env.MINESHELL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mineshell-test-'));
  // The systemd user unit folder lives under XDG_CONFIG_HOME; keep it in the
  // throwaway directory too so no test can write real unit files.
  process.env.XDG_CONFIG_HOME = path.join(process.env.MINESHELL_DATA, 'xdg-config');
  process.env.MINESHELL_UNIT_PREFIX = 'mineshell-test';
  process.env.MINESHELL_AUTH = 'off';
}

export default defineConfig({
  plugins: [
    // SvelteKit 3 takes its configuration here; svelte.config.js is no longer read.
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ out: 'build' }),
      // SvelteKit loads .env through its own setting, not Vite's envDir. Under
      // Vitest it reads tests/env (no .env there), so tests never see the real
      // MINESHELL_DATA. tests/setup.ts double-checks and aborts otherwise.
      env: { dir: testing ? 'tests/env' : '.' },
      csrf: {
        // SvelteKit's own check compares the full origin, which breaks behind
        // TLS-terminating proxies (the app sees http, the browser https).
        // src/lib/server/guard.ts does the cross-site check instead, comparing
        // hosts only - so raw-IP, alternate-hostname and proxied access work,
        // and other sites (or other ports on the same machine) are refused.
        // '*' turns SvelteKit's own check off (checkOrigin was removed).
        trustedOrigins: ['*']
      }
    })
  ],
  envDir: testing ? 'tests/env' : undefined,
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/global-setup.ts'],
    environment: 'node',
    // Recording real API responses (RECORD_HTTP=1, tests/helpers/http.ts)
    // waits on live servers; replaying them is instant.
    testTimeout: process.env.RECORD_HTTP ? 60_000 : 5_000,
    // Every test file shares the one throwaway database (SvelteKit fixes the
    // env once per run), and parallel workers migrating it at the same time
    // lock it, so files simply run in turn (the suite takes about half a minute).
    fileParallelism: false
  },
  server: {
    host: '0.0.0.0',
    port: 5173
  },
  // better-sqlite3 is a native module; keep it out of Vite's dep optimiser.
  optimizeDeps: { exclude: ['better-sqlite3'] },
  ssr: { external: ['better-sqlite3'] }
});
