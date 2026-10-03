import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: 'build' }),
    // SvelteKit loads .env through its own setting, not Vite's envDir. Under
    // Vitest it reads tests/env (no .env there), so tests never see the real
    // MINESHELL_DATA. tests/setup.ts double-checks and aborts otherwise.
    env: { dir: process.env.VITEST ? 'tests/env' : '.' },
    csrf: {
      // SvelteKit's own check compares the full origin, which breaks behind
      // TLS-terminating proxies (the app sees http, the browser https).
      // src/lib/server/guard.ts does the cross-site check instead, comparing
      // hosts only - so raw-IP, alternate-hostname and proxied access work,
      // and other sites (or other ports on the same machine) are refused.
      checkOrigin: false
    }
  }
};

export default config;
