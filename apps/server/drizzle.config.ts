import type { Config } from 'drizzle-kit';

// Only drizzle-kit reads this file, and only for `generate` and `check` — both
// of which work purely from schema.ts and the migrations folder and never touch
// a database. So no DATABASE_URL is needed here, and `npm run typecheck` stays
// free of any codegen step.
export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
} satisfies Config;
