import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { sql, type SQL } from 'drizzle-orm';

import { vocabularyQueries } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';

// Spec §6. On a small table the planner rightly prefers a sequential scan, so
// the plan shape only means something at volume: ~200k entries over ~1k
// enrollments, plus one heavy enrollment with 20k. The assertion is the ABSENCE
// of a Seq Scan on the two big tables — the part of a plan that stays stable
// across Postgres versions — and an Execution Time budget for the list page.
//
// If one of these fails, read the plan in the failure before touching the
// assertion. The fix is an index or a query shape, never a looser test.

const WATCHED = ['vocabulary_entries', 'dict_var_translations'];
const HEAVY = 'pe1';
const BUDGET_MS = 50;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; Plans?: PlanNode[] };
type Explained = { Plan: PlanNode; 'Execution Time': number };

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  // One statement per execute and no bind parameters: node-postgres refuses a
  // multi-statement string once it carries parameters.
  const LOAD = [
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
    `insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
       select 'pv' || g, 'ps' || g, 'he', 'מילה' || g, 0 from generate_series(1, 20000) g`,
    `insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
       select 'pe' || e, 'ps' || s, 'pl' || s, 'pv' || s, now() - (s || ' seconds')::interval
       from generate_series(2, 1000) e, generate_series(1, 200) s`,
    `insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
       select '${HEAVY}', 'ps' || s, 'pl' || s, 'pv' || s, now() - (s || ' seconds')::interval
       from generate_series(1, 20000) s`,
  ];
  for (const statement of LOAD) await t.db.execute(sql.raw(statement));
  // Outside any transaction (VACUUM refuses one), so the visibility map is set
  // and an index-only scan is available, and the planner has real statistics.
  for (const table of ['vocabulary_entries', 'dict_var_translations', 'dict_senses', 'dict_lexemes', 'dict_variants']) {
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

const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
const seqScans = (plan: Explained) =>
  nodes(plan.Plan)
    .filter((n) => n['Node Type'] === 'Seq Scan' && WATCHED.includes(n['Relation Name'] ?? ''))
    .map((n) => n['Relation Name']);

const FIRST_50 = Array.from({ length: 50 }, (_, i) => `pl${i + 1}`);

describe('every vocabulary read at volume', () => {
  it.each([
    ['saveable', () => vocabularyQueries.saveable({
      entries: [{ senseId: 'ps5', variantId: 'pv5' }, { senseId: 'ps6', variantId: 'pv6' }],
      targetLanguage: 'ru',
      sourceLanguage: 'he',
    })],
    ['savedSenseIds', () => vocabularyQueries.savedSenseIds({
      enrollmentId: HEAVY,
      senseIds: ['ps1', 'ps2', 'ps3', 'ps4', 'ps5'],
    })],
    ['wordsPage, first page', () => vocabularyQueries.wordsPage({ enrollmentId: HEAVY, limit: 51, after: null })],
    ['wordsPage, after a cursor', () => vocabularyQueries.wordsPage({
      enrollmentId: HEAVY,
      limit: 51,
      after: { savedAt: '2000-01-01 00:00:00+00', lexemeId: 'pl1' },
    })],
    ['wordSummaries', () => vocabularyQueries.wordSummaries({
      enrollmentId: HEAVY,
      lexemeIds: FIRST_50,
      sourceLanguage: 'he',
    })],
    ['lexemeRenderings', () => vocabularyQueries.lexemeRenderings({ lexemeId: 'pl7', userLanguageCode: 'he' })],
    ['savedInLexeme', () => vocabularyQueries.savedInLexeme({ enrollmentId: HEAVY, lexemeId: 'pl7' })],
  ])('%s scans no watched table sequentially', async (_name, build) => {
    const plan = await explain(build());
    expect(seqScans(plan)).toEqual([]);
  });

  it(`serves the heavy enrollment's first list page in under ${BUDGET_MS} ms`, async () => {
    // Warm once, so the budget measures the plan rather than a cold cache.
    await explain(vocabularyQueries.wordsPage({ enrollmentId: HEAVY, limit: 51, after: null }));
    const plan = await explain(vocabularyQueries.wordsPage({ enrollmentId: HEAVY, limit: 51, after: null }));
    expect(plan['Execution Time']).toBeLessThan(BUDGET_MS);
  });
});
