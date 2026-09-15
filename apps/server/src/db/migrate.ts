import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';

import type { Db } from './client';

const MIGRATIONS_FOLDER = path.join(__dirname, 'migrations');

// Embedding options as jsonb gives up the constraints a separate
// question_options table would have enforced. This function restores them, and
// keeps them in the database rather than scattered through the repository.
//
// It lives here rather than in a migration file because drizzle-kit cannot
// generate CREATE FUNCTION, and a hand-edit to a generated migration would be
// silently lost the next time anyone runs `db:generate`. CREATE OR REPLACE is
// idempotent, and running it before migrate() guarantees the function exists
// before the CHECK constraint that references it.
const OPTIONS_VALIDATION_FUNCTION = sql`
  create or replace function question_options_valid(opts jsonb) returns boolean
    language sql immutable as $$
    select jsonb_typeof(opts) = 'array'
       and jsonb_array_length(opts) >= 2
       and jsonb_array_length(
             jsonb_path_query_array(opts, '$[*] ? (@.is_correct == true)')) = 1
       and (select count(distinct (o->>'position')) = jsonb_array_length(opts)
               and min((o->>'position')::int) = 0
               and max((o->>'position')::int) = jsonb_array_length(opts) - 1
               and count(distinct (o->>'text')) = jsonb_array_length(opts)
            from jsonb_array_elements(opts) o)
  $$;
`;

// Beside question_options_valid and for the reason that one gives: drizzle-kit
// cannot generate CREATE FUNCTION, a hand-edit to a generated migration would be
// silently lost the next time anyone runs `db:generate`, and CREATE OR REPLACE
// before migrate() is idempotent and guarantees the function exists before the
// CHECK constraint that references it.
//
// `text[]` rather than `jsonb`, matching session_questions.option_order's use of
// a Postgres array for a homogeneous list. The count cap is here rather than in a
// column type because nothing in Postgres bounds an array's length.
const CORRECTION_ALTERNATIVES_FUNCTION = sql`
  create or replace function correction_alternatives_valid(alts text[]) returns boolean
    language sql immutable as $$
    select coalesce(array_length(alts, 1), 0) <= 3
       and not exists (select 1 from unnest(alts) a where length(a) not between 1 and 100)
    $$;
`;

export async function runMigrations(db: Db): Promise<void> {
  await db.execute(OPTIONS_VALIDATION_FUNCTION);
  await db.execute(CORRECTION_ALTERNATIVES_FUNCTION);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
