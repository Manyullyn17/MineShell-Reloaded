import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Under Vitest, env files come from tests/env (which has none; see also
// kit.env.dir in svelte.config.js), so the real .env - and with it the real
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
  plugins: [sveltekit()],
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
    // lock it. The suite takes about a second, so files simply run in turn.
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
