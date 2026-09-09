import type { Config } from 'drizzle-kit';

// Only used when you change src/lib/server/db/schema.ts and want drizzle-kit to
// draft a new SQL migration for you. At runtime MineShell applies the plain .sql
// files in ./migrations itself, so drizzle-kit is never needed in production.
export default {
  schema: './src/lib/server/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite'
} satisfies Config;
