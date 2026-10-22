import { createHash } from 'node:crypto';
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

// SvelteKit writes the env a process started with into its output folder
// (generated/dev/env/config.js), and every dev server watching that folder
// reloads with it. A shared folder let one process switch another onto its
// data: `npm test` moved a running `npm run dev` to the test's temporary
// directory, a throwaway dev server moved it to /tmp/ms-test. So a test run,
// and a dev server given its own MINESHELL_DATA on the command line, each get
// a folder of their own. A plain `npm run dev` (data from .env) keeps
// .svelte-kit.
const explicitData = !testing && process.env.MINESHELL_DATA;
const outDir = testing
  ? '.svelte-kit-test'
  : explicitData
    ? `.svelte-kit-${createHash('sha256').update(path.resolve(explicitData)).digest('hex').slice(0, 8)}`
    : '.svelte-kit';

// A throwaway dev server's folder is of no use once it stops, so it removes
// its own on the way out (only SIGKILL leaves one behind - delete those by
// hand). The signals are caught because a plain kill skips 'exit' handlers.
if (explicitData && process.argv.includes('dev')) {
  process.once('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => process.exit());
}

// MineShell's own version, for the update check (src/lib/server/selfupdate.ts).
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string;

// Which test files replace modules is read from the files themselves, so a new
// test using vi.mock lands in the isolated project without anyone remembering to
// list it.
const allTests = testing
  ? fs.globSync(['src/**/*.test.ts', 'tests/**/*.test.ts']).map((f) => f.split(path.sep).join('/'))
  : [];
const mockingTests = allTests.filter((f) => /\bvi\.mock\(/.test(fs.readFileSync(f, 'utf8')));
const otherTests = allTests.filter((f) => !mockingTests.includes(f));

export default defineConfig({
  define: { __MINESHELL_VERSION__: JSON.stringify(version) },
  plugins: [
    // SvelteKit 3 takes its configuration here; svelte.config.js is no longer read.
    sveltekit({
      preprocess: vitePreprocess(),
      outDir,
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
    setupFiles: ['tests/setup.ts'],
    // What a test logs is shown only when it fails: a passing run was over a thousand lines
    // of migrations (every fresh test database) and expected warnings.
    silent: 'passed-only',
    globalSetup: ['tests/global-setup.ts'],
    environment: 'node',
    // Recording real API responses (RECORD_HTTP=1, tests/helpers/http.ts)
    // waits on live servers; replaying them is instant. GitHub's runners are
    // about five times slower at the tests that move many files (a pack change
    // stopped at every move: 1 s here with three workers, over 5 s there once
    // files ran side by side), so CI gets more room; 5 s here keeps a test
    // that got slow visible.
    testTimeout: process.env.RECORD_HTTP ? 60_000 : process.env.CI ? 20_000 : 5_000,
    // Files run side by side: each worker has its own data directory and
    // database inside the run's (tests/helpers/env.ts, mocked into
    // $app/env/private by tests/setup.ts).
    projects: [
      // Files that replace modules (vi.mock) keep a fresh module registry each:
      // a mock cannot reach modules another file already loaded, and a module
      // loaded under one file's mock would stay mocked for the next.
      { extends: true, test: { name: 'isolated', include: mockingTests, isolate: true } },
      // The rest load the app's modules once and share them: evaluating them
      // again for every file was half of the suite's time. The price: module
      // state (caches, registries) outlives a file, so a test must leave none
      // behind that another file could trip over - or use vi.mock after all.
      { extends: true, test: { name: 'shared', include: otherTests, isolate: false } }
    ]
  },
  server: {
    host: '0.0.0.0',
    port: 5173
  },
  // better-sqlite3 is a native module; keep it out of Vite's dep optimiser.
  optimizeDeps: { exclude: ['better-sqlite3'] },
  ssr: { external: ['better-sqlite3'] }
});
