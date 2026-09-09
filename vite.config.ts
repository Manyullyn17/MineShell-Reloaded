import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: '0.0.0.0',
    port: 5173
  },
  // better-sqlite3 is a native module; keep it out of Vite's dep optimiser.
  optimizeDeps: { exclude: ['better-sqlite3'] },
  ssr: { external: ['better-sqlite3'] }
});
