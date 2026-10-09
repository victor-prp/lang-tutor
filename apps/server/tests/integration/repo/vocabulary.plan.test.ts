import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';
import { sql, type SQL } from 'drizzle-orm';

import { vocabularyQueries } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';

// Spec §6. On a small table the planner rightly prefers a sequential scan, so
// the plan shape only means something at volume: ~200k entries over ~1k
// enrollments, plus one heavy enrollment with 20k. The assertion is the ABSENCE
// of a Seq Scan on the three big tables — the part of a plan that stays stable
// across Postgres versions — and an Execution Time budget for the list page.
//
// If one of these fails, read the plan in the failure before touching the
// assertion. The fix is an index or a query shape, never a looser test.

const WATCHED = ['vocabulary_entries', 'dict_var_translations', 'gloss_progress', 'dict_lexemes', 'dict_glosses', 'dict_sense_glosses'];
const HEAVY = 'pe1';
const BUDGET_MS = 50;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
type Explained = { Plan: PlanNode; 'Execution Time': number };

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  // One statement per execute and no bind parameters: node-postgres refuses a
  // multi-statement string once it carries parameters.
  const LOAD = [
    // Phase 29: a profile needs a sign-in identity under its id (migration 0023).
    `insert into auth_users (id, name, email)
       select 'pu' || g, 'p', 'pu' || g || '@test.invalid' from generate_series(1, 1000) g`,
    `insert into users (id, username, display_name, age, native_language)
       select 'pu' || g, 'pu' || g, 'p', 30, 'he' from generate_series(1, 1000) g`,
    `insert into enrollments (id, user_id, source_language, target_language)
       select 'pe' || g, 'pu' || g, 'he', 'ru' from generate_series(1, 1000) g`,
    `insert into dict_lexemes (id, language_code, lemma, part_of_speech)
       select 'pl' || g, 'ru', 'слово' || g, 'noun' from generate_series(1, 20000) g`,
    `insert into dict_senses (id, lexeme_id, sense_code)
       select 'ps' || g, 'pl' || g, 'only' from generate_series(1, 20000) g`,
    `insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
       select 'pv' || g, 'pl' || g, 'ru', 'слово' || g, 'word', 0 from generate_series(1, 20000) g`,
    `insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, gloss, rank)
       select 'pv' || g, 'ps' || g, 'he', 'מילה' || g, 'מילה' || g, 0 from generate_series(1, 20000) g`,
    `insert into dict_glosses (id, lexeme_id, user_language_code, key)
       select 'pg' || g, 'pl' || g, 'he', 'מילה' || g from generate_series(1, 20000) g`,
    `insert into dict_sense_glosses (sense_id, lexeme_id, user_language_code, gloss_id)
       select 'ps' || g, 'pl' || g, 'he', 'pg' || g from generate_series(1, 20000) g`,
    `insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, created_at, added_by_user_id)
       select 'pe' || e, 'pg' || s, 'pl' || s, 'слово' || s, 'pv' || s, now() - (s || ' seconds')::interval, 'pu' || e
       from generate_series(2, 1000) e, generate_series(1, 200) s`,
    `insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, created_at, added_by_user_id)
       select '${HEAVY}', 'pg' || s, 'pl' || s, 'слово' || s, 'pv' || s, now() - (s || ' seconds')::interval, 'pu1'
       from generate_series(1, 20000) s`,
    // Phase 20. Five progress rows per entry, levels spread over 1–5 so a level
    // filter has real work to do. `& 2147483647` keeps hashtext non-negative
    // without abs(), which overflows on the one negative int4 with no positive.
    `insert into gloss_progress (enrollment_id, gloss_id, dimension, level)
       select ve.enrollment_id, ve.gloss_id, d, 1 + ((hashtext(ve.gloss_id || d) & 2147483647) % 5)
       from vocabulary_entries ve
       cross join unnest(array['written_receptive', 'written_productive', 'spoken_receptive',
                               'spoken_productive', 'spelling']) d`,
  ];
  for (const statement of LOAD) await t.db.execute(sql.raw(statement));
  // Outside any transaction (VACUUM refuses one), so the visibility map is set
  // and an index-only scan is available, and the planner has real statistics.
  for (const table of ['vocabulary_entries', 'dict_var_translations', 'dict_senses', 'dict_lexemes', 'dict_variants', 'gloss_progress', 'dict_glosses', 'dict_sense_glosses']) {
    await t.db.execute(sql.raw(`vacuum analyze ${table}`));
  }
}, 120_000);

afterAll(async () => {
  await t.close();
});

async function explain(query: SQL): Promise<Explained> {
  const result = await t.db.execute<{ 'QUERY PLAN': Explained[] }>(
    sql`explain (analyze, format json) ${query}`,
  );
  return result.rows[0]['QUERY PLAN'][0];
}

// Execution Time on a CI runner is the query's cost plus whatever the other Jest
// workers are doing to the same CPU and Postgres. Since ci.yml keeps Jest's
// timings, this file starts first, while every other worker is cloning
// databases: single samples landed at 50.4 and 52.3 ms there, against ~14 ms
// for the same query alone. A query's cost is the least time it takes, so the
// budget is held against the best of five warm runs. BUDGET_MS is unchanged, and
// a worse plan (a Seq Scan, a sort of all 20k entries) is slow in every run.
async function bestExecutionTime(query: SQL): Promise<number> {
  // Warm once, so the budget measures the plan rather than a cold cache.
  await explain(query);
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 5; run++) best = Math.min(best, (await explain(query))['Execution Time']);
  return best;
}

// EXPLAIN ANALYZE of a write executes it, so a write is explained inside a
// transaction that is always rolled back: the heavy fixture stays as loaded.
class Rollback extends Error {}
async function explainWrite(query: SQL): Promise<Explained> {
  let plan: Explained | undefined;
  await t.db
    .transaction(async (tx) => {
      const result = await tx.execute<{ 'QUERY PLAN': Explained[] }>(
        sql`explain (analyze, format json) ${query}`,
      );
      plan = result.rows[0]['QUERY PLAN'][0];
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  if (!plan) throw new Error('no plan was captured');
  return plan;
}

const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
const seqScans = (plan: Explained) =>
  nodes(plan.Plan)
    .filter((n) => n['Node Type'] === 'Seq Scan' && WATCHED.includes(n['Relation Name'] ?? ''))
    .map((n) => n['Relation Name']);

const indexesUsed = (plan: Explained) => nodes(plan.Plan).flatMap((n) => (n['Index Name'] ? [n['Index Name']] : []));

const FIRST_50 = Array.from({ length: 50 }, (_, i) => `слово${i + 1}`);
const PAGE = { enrollmentId: HEAVY, limit: 51, level: null, live: LIVE_DIMENSIONS };

// Every shape of the list page. Each reads progress through the covering index.
const WORDS_PAGES: [string, () => SQL][] = [
  ['wordsPage, first page', () => vocabularyQueries.wordsPage({ ...PAGE, after: null })],
  ['wordsPage, after a cursor', () => vocabularyQueries.wordsPage({
    ...PAGE,
    after: { savedAt: '2000-01-01 00:00:00+00', lemma: 'слово1' },
  })],
  ['wordsPage, one level', () => vocabularyQueries.wordsPage({ ...PAGE, level: 2, after: null })],
];

describe('every vocabulary read at volume', () => {
  it.each([
    ['saveable', () => vocabularyQueries.saveable({
      entries: [{ glossId: 'pg5', variantId: 'pv5' }, { glossId: 'pg6', variantId: 'pv6' }],
      targetLanguage: 'ru',
      sourceLanguage: 'he',
    })],
    ['savedGlossIds', () => vocabularyQueries.savedGlossIds({
      enrollmentId: HEAVY,
      glossIds: ['pg1', 'pg2', 'pg3', 'pg4', 'pg5'],
    })],
    ...WORDS_PAGES,
    ['wordSummaries', () => vocabularyQueries.wordSummaries({
      enrollmentId: HEAVY,
      lemmas: FIRST_50,
      targetLanguage: 'ru',
      sourceLanguage: 'he',
      ownerUserId: 'pu1',
    })],
    ['lemmaLexemes', () => vocabularyQueries.lemmaLexemes({ languageCode: 'ru', lemma: 'слово7' })],
    ['lemmaRenderings', () => vocabularyQueries.lemmaRenderings({
      languageCode: 'ru',
      lemma: 'слово7',
      userLanguageCode: 'he',
    })],
    ['savedInLemma', () => vocabularyQueries.savedInLemma({ enrollmentId: HEAVY, lemma: 'слово7', ownerUserId: 'pu1' })],
  ])('%s scans no watched table sequentially', async (_name, build) => {
    const plan = await explain(build());
    expect(seqScans(plan)).toEqual([]);
  });

  // The scan check alone is not enough: a bitmap scan on gloss_progress_pkey
  // dodges it, and the budget below is met without the index (35 ms measured).
  it.each(WORDS_PAGES)('%s reads progress through gloss_progress_enrollment_dimension_idx', async (_name, build) => {
    const plan = await explain(build());
    expect(indexesUsed(plan)).toContain('gloss_progress_enrollment_dimension_idx');
  });

  // The scan check alone cannot tell the lemma index from a bitmap scan of the
  // primary key's enrollment prefix, which reads the whole heavy enrollment.
  it('reads one lemma of the heavy enrollment through vocabulary_entries_enrollment_lemma_idx', async () => {
    const plan = await explain(vocabularyQueries.savedInLemma({ enrollmentId: HEAVY, lemma: 'слово7', ownerUserId: 'pu1' }));
    expect(indexesUsed(plan)).toContain('vocabulary_entries_enrollment_lemma_idx');
  });

  // Save and unsave, spec §3: a primary-key insert and a primary-key delete,
  // against the heavy enrollment so a table-sized scan would show.
  it.each([
    ['insertEntries', () => vocabularyQueries.insertEntries({
      enrollmentId: 'pe2',
      addedByUserId: 'pu2',
      entries: [{ glossId: 'pg300', lexemeId: 'pl300', lemma: 'слово300', variantId: 'pv300' }],
    })],
    ['deleteEntry', () => vocabularyQueries.deleteEntry({ enrollmentId: HEAVY, glossId: 'pg5' })],
  ])('%s scans no watched table sequentially', async (_name, build) => {
    const plan = await explainWrite(build());
    expect(seqScans(plan)).toEqual([]);
  });

  it(`serves the heavy enrollment's first list page in under ${BUDGET_MS} ms`, async () => {
    expect(await bestExecutionTime(vocabularyQueries.wordsPage({ ...PAGE, after: null }))).toBeLessThan(BUDGET_MS);
  });

  it(`serves the heavy enrollment's first one-level page in under ${BUDGET_MS} ms`, async () => {
    expect(await bestExecutionTime(vocabularyQueries.wordsPage({ ...PAGE, level: 2, after: null }))).toBeLessThan(
      BUDGET_MS,
    );
  });
});
