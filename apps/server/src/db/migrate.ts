import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';

import type { Db } from './client';
import { installJobs } from './jobs';

export const MIGRATIONS_FOLDER = path.join(__dirname, 'migrations');

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

// Phase 31 (spec §2). The SQL twin of normaliseGloss in packages/core, which the
// unique index on live glosses and the migrations run on. Here for the reason the
// two above give. String.raw keeps the regex backslashes for Postgres: a template
// literal would turn \( into a bare (, so '([^)]*)' would match the whole string,
// and would write the space class's escapes as invisible characters.
//
// The space class is JavaScript's \s spelled out, because Postgres's own \s
// follows the database's ctype, which leaves out the no-break spaces and U+FEFF:
// TAB, LF, VT, FF, CR, SPACE, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029,
// U+202F, U+205F, U+3000 and U+FEFF. Each run of them becomes one space, so the
// spaces btrim then removes are exactly what trim() removes. lower() and
// toLowerCase() part ways on the dotted capital I and the Greek final sigma,
// which none of the app's languages (en, ru, it, he) uses.
//
// It must stay character for character the same as normaliseGloss: the schema
// integration test runs both over one list. Changing it needs a migration that
// REINDEXes dict_glosses_live_key and dict_glosses_language_key_idx.
const GLOSS_KEY_FUNCTION = sql.raw(String.raw`
  create or replace function gloss_key(t text) returns text
    language sql immutable parallel safe as $$
    select lower(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
             normalize(t, NFC),
             '[־-]', ' ', 'g'),
             '[֑-ׇ́]', '', 'g'),
             '\([^)]*\)', '', 'g'),
             '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g')))
  $$;
`);

/** `folder` is a parameter so a migration test can stop at a chosen migration,
 *  insert rows shaped by the schema of that moment, then migrate the rest. */
export async function runMigrationsFrom(db: Db, folder: string): Promise<void> {
  await db.execute(OPTIONS_VALIDATION_FUNCTION);
  await db.execute(CORRECTION_ALTERNATIVES_FUNCTION);
  await db.execute(GLOSS_KEY_FUNCTION);
  await migrate(db, { migrationsFolder: folder });
  // Phase 19. pg-boss's schema and queues, after the app's own tables. They
  // share nothing, so the order is only about failing on the app's migration
  // first.
  await installJobs(db);
}

export async function runMigrations(db: Db): Promise<void> {
  await runMigrationsFrom(db, MIGRATIONS_FOLDER);
}
