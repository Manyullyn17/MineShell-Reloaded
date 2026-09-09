import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: 'build' }),
    csrf: {
      // MineShell is a LAN tool that is frequently reached by raw IP or an
      // alternate hostname, which trips SvelteKit's strict origin check on
      // form posts. Auth + same-site cookies are the real protection here.
      checkOrigin: false
    }
  }
};

export default config;
