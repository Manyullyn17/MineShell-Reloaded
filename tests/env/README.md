Deliberately empty of `.env` files: `vite.config.ts` points `envDir` here when Vitest runs,
so the real `.env` (and its `MINESHELL_DATA`) is never loaded into tests.
