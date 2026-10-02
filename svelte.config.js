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
      // MineShell is a LAN tool that is frequently reached by raw IP or an
      // alternate hostname, which trips SvelteKit's strict origin check on
      // form posts. Auth + same-site cookies are the real protection here.
      checkOrigin: false
    }
  }
};

export default config;
