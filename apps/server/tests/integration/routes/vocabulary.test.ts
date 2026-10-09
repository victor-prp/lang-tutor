import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createVocabularyRouter } from '../../../src/routes/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { seedGrant } from '../../support/grantRows';
import { setLevel } from '../../support/progressRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let logger: FakeLogger;
const RU = 'e_ru';

// A Russian word with two senses rendered in Hebrew by one form.
async function russianWord(lemma: string, form = lemma) {
  return insertLexeme(t.db, {
    lemma,
    languageCode: 'ru',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'first' }, { senseCode: 'second' }],
    variants: [
      {
        form,
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'first', rank: 0, translation: `${lemma}-1`, exampleSource: null, exampleTarget: null },
          { senseCode: 'second', rank: 1, translation: `${lemma}-2`, exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
}

// A Russian verb with one sense. Its form is the lemma at entry rank 1, so it can
// share a lemma, and a form, with a noun from russianWord.
async function russianVerb(lemma: string, translation: string) {
  return insertLexeme(t.db, {
    lemma,
    languageCode: 'ru',
    partOfSpeech: 'verb',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'verb' }],
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 1,
        translations: [{ senseCode: 'verb', rank: 0, translation, exampleSource: null, exampleTarget: null }],
      },
    ],
  });
}

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  await seedUser(t.db, 'u_1'); // also holds e_u_1, English
  await seedEnrollment(t.db, { id: RU, userId: 'u_1', targetLanguage: 'ru' });
});
afterEach(async () => {
  await t.close();
});

function app() {
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7) });
  const hono = new Hono();
  hono.route('/api', createVocabularyRouter(deps.vocabulary));
  return hono;
}

const save = (enrollmentId: string, entries: unknown, actor = 'u_1') =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Acting-User-Id': actor },
    body: JSON.stringify({ entries }),
  });
const unsave = (enrollmentId: string, glossId: string, actor = 'u_1') =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary/glosses/${glossId}`, {
    method: 'DELETE',
    headers: { 'X-Acting-User-Id': actor },
  });
const list = (enrollmentId: string, query = '') =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary${query}`);
const detail = (enrollmentId: string, lemma: string) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary/word?lemma=${encodeURIComponent(lemma)}`);

type Page = {
  items: {
    lemma: string;
    saved_count: number;
    gloss_count: number;
    parts_of_speech: string[];
    headline: { gloss_id: string; translation: string; form: string };
  }[];
  next_cursor: string | null;
};

describe('POST /api/enrollments/{id}/vocabulary', () => {
  it('saves a sense, and the list shows its word', async () => {
    const rama = await russianWord('рама');
    const res = await save(RU, [{ gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_gloss_ids: [rama.glossIds[0]] });

    const page = (await (await list(RU)).json()) as Page;
    expect(page.items).toEqual([
      {
        lemma: 'рама',
        parts_of_speech: ['noun'],
        headline: { gloss_id: rama.glossIds[0], translation: 'рама-1', form: 'рама' },
        saved_count: 1,
        gloss_count: 2,
        level: 1,
        added_by: [],
      },
    ]);
    expect(page.next_cursor).toBeNull();
  });

  it('writes nothing when one item of the batch is refused', async () => {
    const rama = await russianWord('рама');
    const english = await insertLexeme(t.db, {
      lemma: 'casement',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'pane' }],
      variants: [
        {
          form: 'casement',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'pane', rank: 0, translation: 'חלון', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const res = await save(RU, [
      { gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] },
      { gloss_id: english.glossIds[0], variant_id: english.variantIds[0] },
    ]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid vocabulary entry' });
    // The body names nothing; the log names the refused sense (spec §4).
    expect(logger.events).toContainEqual({
      event: 'vocabulary_entry_refused',
      enrollment_id: RU,
      gloss_id: english.glossIds[0],
      variant_id: english.variantIds[0],
    });
    expect(((await (await list(RU)).json()) as Page).items).toEqual([]);
  });

  // Review Focus 1.
  it('saves a sense sent twice in one batch once, with 200', async () => {
    const rama = await russianWord('рама');
    const entry = { gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] };
    const res = await save(RU, [entry, entry]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_gloss_ids: [rama.glossIds[0]] });
    expect(((await (await list(RU)).json()) as Page).items[0].saved_count).toBe(1);
  });

  it('answers 404 for an unknown enrollment', async () => {
    const rama = await russianWord('рама');
    const res = await save('e_nobody', [{ gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] }]);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });

  it.each([
    ['no entries', []],
    ['twenty-one entries', Array(21).fill({ gloss_id: 's', variant_id: 'v' })],
  ])('answers 400 for %s', async (_label, entries) => {
    const res = await save(RU, entries);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});

describe('DELETE /api/enrollments/{id}/vocabulary/glosses/{gloss_id}', () => {
  it('unsaves, idempotently', async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] }]);
    expect((await unsave(RU, rama.glossIds[0])).status).toBe(204);
    expect((await unsave(RU, rama.glossIds[0])).status).toBe(204);
    expect(((await (await list(RU)).json()) as Page).items).toEqual([]);
  });

  it('answers 404 for an unknown enrollment', async () => {
    expect((await unsave('e_nobody', 's')).status).toBe(404);
  });
});

describe('GET /api/enrollments/{id}/vocabulary', () => {
  // Review Focus 2.
  it.each(['?limit=abc', '?limit=0', '?limit=101', '?limit=1.5'])('answers 400 for %s', async (query) => {
    const res = await list(RU, query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 400 for a cursor this server did not issue', async () => {
    const res = await list(RU, '?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  // Shaped like a cursor the server issues, but the timestamp is not a time:
  // without the range check the ::timestamptz cast raises and this is a 500.
  it('answers 400, not 500, for a well-shaped cursor with an impossible timestamp', async () => {
    const forged = Buffer.from(JSON.stringify(['lemma', '2026-13-45 25:61:00+00', 'рама']), 'utf8').toString(
      'base64url',
    );
    const res = await list(RU, `?cursor=${encodeURIComponent(forged)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 404 for an unknown enrollment', async () => {
    expect((await list('e_nobody')).status).toBe(404);
  });

  it("keeps each enrollment's list to itself", async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] }]);
    expect(((await (await list('e_u_1')).json()) as Page).items).toEqual([]);
  });

  describe('a 120-word walk in pages of 50', () => {
    let words: Awaited<ReturnType<typeof russianWord>>[];

    beforeEach(async () => {
      words = [];
      for (let i = 0; i < 120; i += 1) {
        const word = await russianWord(`слово${i}`);
        await save(RU, [{ gloss_id: word.glossIds[0], variant_id: word.variantIds[0] }]);
        words.push(word);
      }
    }, 60_000);

    async function walk(onPage?: (n: number) => Promise<void>): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; ; n += 1) {
        const query = `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = (await (await list(RU, query)).json()) as Page;
        seen.push(...page.items.map((item) => item.lemma));
        if (onPage) await onPage(n);
        if (!page.next_cursor) return seen;
        cursor = page.next_cursor;
      }
    }

    it('returns every word exactly once, newest first', async () => {
      const seen = await walk();
      expect(seen).toHaveLength(120);
      expect(seen[0]).toBe('слово119');
      expect(seen[119]).toBe('слово0');
      expect(new Set(seen).size).toBe(120);
    });

    it('neither duplicates nor loses a word when an old one moves to the top mid-walk', async () => {
      const moved = words[10];
      const seen = await walk(async (n) => {
        if (n === 0) {
          await save(RU, [{ gloss_id: moved.glossIds[1], variant_id: moved.variantIds[0] }]);
        }
      });
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain('слово10');
      const fresh = (await (await list(RU, '?limit=1')).json()) as Page;
      expect(fresh.items[0]).toMatchObject({ lemma: 'слово10', saved_count: 2 });
    });

    // Review Focus 5: the save lands in the word's OTHER lexeme.
    it("neither duplicates nor loses a word that gains a save in another lexeme of its lemma mid-walk", async () => {
      const verb = await russianVerb('слово10', 'לדבר');
      const seen = await walk(async (n) => {
        if (n === 0) await save(RU, [{ gloss_id: verb.glossIds[0], variant_id: verb.variantIds[0] }]);
      });
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain('слово10');
      const fresh = (await (await list(RU, '?limit=1')).json()) as Page;
      expect(fresh.items[0]).toMatchObject({ lemma: 'слово10', saved_count: 2, parts_of_speech: ['noun', 'verb'] });
    });

    it("drops a word whose last sense is unsaved", async () => {
      await unsave(RU, words[50].glossIds[0]);
      const seen = await walk();
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain('слово50');
    });
  });

  describe('a lemma with two lexemes', () => {
    it('is one row with both parts of speech, counts across both, and one level', async () => {
      const noun = await russianWord('знать');
      const verb = await russianVerb('знать', 'לדעת');
      await save(RU, [
        { gloss_id: noun.glossIds[0], variant_id: noun.variantIds[0] },
        { gloss_id: verb.glossIds[0], variant_id: verb.variantIds[0] },
      ]);
      await setLevel(t.db, { enrollmentId: RU, glossId: noun.glossIds[0], level: 1 });
      await setLevel(t.db, { enrollmentId: RU, glossId: verb.glossIds[0], level: 4 });

      const body = (await (await list(RU)).json()) as { items: Record<string, unknown>[] };
      expect(body.items).toEqual([
        {
          lemma: 'знать',
          parts_of_speech: ['noun', 'verb'],
          headline: expect.objectContaining({ gloss_id: expect.any(String) }),
          saved_count: 2,
          gloss_count: 3,
          level: 3,
          added_by: [],
        },
      ]);
    });

    // Review Focus 4.
    it('keeps the row when the last saved sense of one lexeme is unsaved', async () => {
      const noun = await russianWord('знать');
      const verb = await russianVerb('знать', 'לדעת');
      await save(RU, [
        { gloss_id: noun.glossIds[0], variant_id: noun.variantIds[0] },
        { gloss_id: verb.glossIds[0], variant_id: verb.variantIds[0] },
      ]);
      await setLevel(t.db, { enrollmentId: RU, glossId: verb.glossIds[0], level: 5 });
      await unsave(RU, noun.glossIds[0]);

      const body = (await (await list(RU)).json()) as Page & { items: { level: number }[] };
      expect(body.items).toEqual([
        expect.objectContaining({ lemma: 'знать', parts_of_speech: ['verb'], saved_count: 1, gloss_count: 3, level: 5 }),
      ]);
    });
  });

  // Review Focus 3.
  it.each([
    ['a phase 18 cursor', ['2026-10-04 12:00:00+00', 'lx-1']],
    ['a phase 20 level cursor', ['2026-10-04 12:00:00+00', 'lx-1', 'level_asc', 2]],
  ])('answers 400 for %s', async (_label, fields) => {
    const old = Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
    const res = await list(RU, `?cursor=${encodeURIComponent(old)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('ignores a sort an older app still sends', async () => {
    const res = await list(RU, '?sort=level_asc');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/enrollments/{id}/vocabulary/word', () => {
  type Detail = {
    lemma: string;
    level: number | null;
    senses: { gloss_id: string; saved: boolean; part_of_speech: string; progress?: unknown }[];
  };

  it('lists every sense, saved first, and answers 200 once nothing is saved', async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ gloss_id: rama.glossIds[1], variant_id: rama.variantIds[0] }]);

    const res = await detail(RU, 'рама');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Detail;
    expect(body.lemma).toBe('рама');
    expect(body).not.toHaveProperty('lexeme_id');
    expect(body).not.toHaveProperty('part_of_speech');
    expect(body.senses.map((s) => [s.gloss_id, s.saved, s.part_of_speech])).toEqual([
      [rama.glossIds[1], true, 'noun'],
      [rama.glossIds[0], false, 'noun'],
    ]);

    await unsave(RU, rama.glossIds[1]);
    expect((await detail(RU, 'рама')).status).toBe(200);
  });

  it('merges every lexeme of the lemma: saved first, then by part of speech', async () => {
    const noun = await russianWord('знать');
    const verb = await russianVerb('знать', 'לדעת');
    await save(RU, [
      { gloss_id: verb.glossIds[0], variant_id: verb.variantIds[0] },
      { gloss_id: noun.glossIds[1], variant_id: noun.variantIds[0] },
    ]);
    await setLevel(t.db, { enrollmentId: RU, glossId: verb.glossIds[0], level: 5 });
    await setLevel(t.db, { enrollmentId: RU, glossId: noun.glossIds[1], level: 2 });

    const body = (await (await detail(RU, 'знать')).json()) as Detail;
    expect(body.senses.map((s) => [s.gloss_id, s.saved, s.part_of_speech])).toEqual([
      [noun.glossIds[1], true, 'noun'],
      [verb.glossIds[0], true, 'verb'],
      [noun.glossIds[0], false, 'noun'],
    ]);
    expect(body.level).toBe(4);
  });

  // Review Focus 1.
  it.each(['всё равно', 'и/или'])('finds a lemma that holds a space or a slash: %s', async (lemma) => {
    await russianWord(lemma);
    const res = await detail(RU, lemma);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Detail).lemma).toBe(lemma);
  });

  // Review Focus 2.
  it('matches the lemma exactly, case included', async () => {
    await russianWord('Рама');
    await russianVerb('рама', 'למסגר');
    const body = (await (await detail(RU, 'рама')).json()) as Detail;
    expect(body.senses.map((s) => s.part_of_speech)).toEqual(['verb']);
  });

  it("answers 404 for an unknown lemma and for one outside the enrollment's target", async () => {
    await russianWord('рама');
    expect((await detail(RU, 'нет')).status).toBe(404);
    const wrongLanguage = await detail('e_u_1', 'рама');
    expect(wrongLanguage.status).toBe(404);
    expect(await wrongLanguage.json()).toEqual({ error: 'word not found' });
  });

  // %00 decodes to U+0000, which Postgres refuses in a text parameter: it must fail validation, not reach the query.
  it.each(['', '?lemma=', '?lemma=%00'])('answers 400 for a missing, empty or NUL-holding lemma: "%s"', async (query) => {
    const res = await app().request(`/api/enrollments/${RU}/vocabulary/word${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 404 for an unknown enrollment', async () => {
    await russianWord('рама');
    const res = await detail('e_nobody', 'рама');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });

  it('shows a saved sense with its five levels, an unsaved one with none, and the word with its level', async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] }]);
    await setLevel(t.db, { enrollmentId: RU, glossId: rama.glossIds[0], level: 3 });

    const body = (await (await detail(RU, 'рама')).json()) as Detail;
    expect(body.level).toBe(3);
    expect(body.senses.find((s) => s.gloss_id === rama.glossIds[0])?.progress).toEqual({
      level: 3,
      dimensions: { written_receptive: 3, written_productive: 3, spoken_receptive: 3, spoken_productive: 3, spelling: 3 },
    });
    expect(body.senses.find((s) => s.gloss_id === rama.glossIds[1])).not.toHaveProperty('progress');
  });

  it('gives a word with nothing saved no level', async () => {
    await russianWord('рама');
    expect(((await (await detail(RU, 'рама')).json()) as Detail).level).toBeNull();
  });

  // Phase 31 (spec D2, D3, D10). Two senses one target word renders are one
  // gloss and one card, which saves, levels and unsaves with one entry.
  it('shows the two senses of one gloss as one card, with one save, one entry and one level', async () => {
    const mouse = await insertLexeme(t.db, {
      lemma: 'мышь',
      languageCode: 'ru',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'rodent' }, { senseCode: 'device' }],
      variants: [
        {
          form: 'мышь',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'rodent', rank: 0, translation: 'עכבר', exampleSource: null, exampleTarget: null },
            { senseCode: 'device', rank: 1, translation: 'עכבר', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const gloss = mouse.glossIds[0];
    expect(mouse.glossIds[1]).toBe(gloss);

    const res = await save(RU, [{ gloss_id: gloss, variant_id: mouse.variantIds[0] }]);
    expect(await res.json()).toEqual({ saved_gloss_ids: [gloss] });
    await setLevel(t.db, { enrollmentId: RU, glossId: gloss, level: 3 });
    const body = (await (await detail(RU, 'мышь')).json()) as Detail;
    expect(body.senses.map((s) => [s.gloss_id, s.saved, (s.progress as { level: number } | undefined)?.level])).toEqual([
      [gloss, true, 3],
    ]);
    expect(((await (await list(RU)).json()) as Page).items[0].saved_count).toBe(1);

    await unsave(RU, gloss);
    const after = (await (await detail(RU, 'мышь')).json()) as Detail;
    expect(after.senses.map((s) => s.saved)).toEqual([false]);
  });
});

describe('levels on the list (phase 20)', () => {
  type Leveled = { items: { lemma: string; level: number }[]; next_cursor: string | null };
  const lemmas = async (query: string) => ((await (await list(RU, query)).json()) as Leveled).items.map((i) => i.lemma);

  async function savedWord(lemma: string, level: number) {
    const word = await russianWord(lemma);
    await save(RU, [{ gloss_id: word.glossIds[0], variant_id: word.variantIds[0] }]);
    await setLevel(t.db, { enrollmentId: RU, glossId: word.glossIds[0], level });
    return lemma;
  }

  async function walk(query: string): Promise<Leveled['items']> {
    const seen: Leveled['items'] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await list(RU, `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ).json()) as Leveled;
      seen.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return seen;
  }

  it('shows a newly saved word at level 1', async () => {
    const lemma = await savedWord('арка', 1);
    expect(((await (await list(RU)).json()) as Leveled).items).toEqual([expect.objectContaining({ lemma, level: 1 })]);
  });

  it("averages a word's saved senses, rounding a tie up", async () => {
    const word = await russianWord('рама');
    await save(RU, word.glossIds.map((glossId) => ({ gloss_id: glossId, variant_id: word.variantIds[0] })));
    await setLevel(t.db, { enrollmentId: RU, glossId: word.glossIds[0], level: 2 });
    await setLevel(t.db, { enrollmentId: RU, glossId: word.glossIds[1], level: 3 });
    expect(((await (await list(RU)).json()) as Leveled).items[0].level).toBe(3);
  });

  it('filters to one level, newest first', async () => {
    await savedWord('арка', 1);
    const highOld = await savedWord('бак', 4);
    const highNew = await savedWord('вал', 4);
    expect(await lemmas('?level=4')).toEqual([highNew, highOld]);
    expect(await lemmas('?level=3')).toEqual([]);
  });

  it('walks a filtered list page by page without repeating or losing a word', async () => {
    for (let i = 0; i < 9; i += 1) await savedWord(`слово${i}`, i % 3 === 0 ? 2 : 1);
    const seen = await walk('?level=2&limit=2');
    expect(seen).toHaveLength(3);
    expect(seen.every((item) => item.level === 2)).toBe(true);
    expect(new Set(seen.map((item) => item.lemma)).size).toBe(3);
  });

  it.each(['?level=0', '?level=6', '?level=two'])('answers 400 for %s', async (query) => {
    const res = await list(RU, query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});

describe('access (phase 28)', () => {
  const asked = async () => {
    const rama = await russianWord('рама');
    return [{ gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] }];
  };

  it('answers 400 for a save without the acting-user header', async () => {
    const res = await app().request(`/api/enrollments/${RU}/vocabulary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: await asked() }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 403 for a save by someone who holds no grant', async () => {
    await seedUser(t.db, 'u_2');
    const res = await save(RU, await asked(), 'u_2');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('lets an accepted tutor save', async () => {
    await seedUser(t.db, 'u_tutor');
    await seedGrant(t.db, { enrollmentId: RU, ownerUserId: 'u_1', granteeUserId: 'u_tutor', accepted: true });
    expect((await save(RU, await asked(), 'u_tutor')).status).toBe(200);
  });

  it('answers 403 when that tutor unsaves', async () => {
    await seedUser(t.db, 'u_tutor');
    await seedGrant(t.db, { enrollmentId: RU, ownerUserId: 'u_1', granteeUserId: 'u_tutor', accepted: true });
    const entries = await asked();
    await save(RU, entries, 'u_tutor');
    const res = await unsave(RU, entries[0].gloss_id, 'u_tutor');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it("labels a tutor's word with the tutor's display name, on the list and the word's page", async () => {
    await seedUser(t.db, 'u_tutor');
    await seedGrant(t.db, { enrollmentId: RU, ownerUserId: 'u_1', granteeUserId: 'u_tutor', accepted: true });
    const rama = await russianWord('рама');
    await save(RU, [{ gloss_id: rama.glossIds[0], variant_id: rama.variantIds[0] }], 'u_tutor');
    await save(RU, [{ gloss_id: rama.glossIds[1], variant_id: rama.variantIds[0] }], 'u_1');

    const page = (await (await list(RU)).json()) as { items: { added_by: string[] }[] };
    expect(page.items).toEqual([expect.objectContaining({ lemma: 'рама', saved_count: 2, added_by: ['test u_tutor'] })]);

    const body = (await (await detail(RU, 'рама')).json()) as { senses: { gloss_id: string; added_by?: string }[] };
    const bySense = new Map(body.senses.map((s) => [s.gloss_id, s]));
    expect(bySense.get(rama.glossIds[0])).toHaveProperty('added_by', 'test u_tutor');
    expect(bySense.get(rama.glossIds[1])).not.toHaveProperty('added_by');
  });

  it('answers 404 before 403: an unknown enrollment is not found for anyone', async () => {
    expect((await save('e_missing', await asked(), 'u_stranger')).status).toBe(404);
  });
});

type Detail = {
  senses: { gloss_id: string; translation: string; saved: boolean; examples: unknown[]; saved_from?: { form: string; translation: string } }[];
};

describe('glosses on the list and the word page (phase 31)', () => {
  it('shows two senses with one target word as one card, saved once and counted once', async () => {
    const mouse = await insertLexeme(t.db, {
      lemma: 'мышь',
      languageCode: 'ru',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'rodent' }, { senseCode: 'device' }],
      variants: [
        {
          form: 'мышь',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'rodent', rank: 0, translation: 'עכבר', exampleSource: 'Мышь бежит.', exampleTarget: 'עכבר רץ.' },
            { senseCode: 'device', rank: 1, translation: 'עכבר', exampleSource: 'Кликни мышью.', exampleTarget: 'לחץ בעכבר.' },
          ],
        },
      ],
    });
    expect(mouse.glossIds[0]).toBe(mouse.glossIds[1]);
    expect((await save(RU, [{ gloss_id: mouse.glossIds[0], variant_id: mouse.variantIds[0] }])).status).toBe(200);

    const page = (await (await list(RU)).json()) as Page;
    expect(page.items[0]).toMatchObject({ lemma: 'мышь', saved_count: 1, gloss_count: 1, headline: { translation: 'עכבר', form: 'мышь' } });
    const word = (await (await detail(RU, 'мышь')).json()) as Detail;
    expect(word.senses).toHaveLength(1);
    expect(word.senses[0]).toMatchObject({ gloss_id: mouse.glossIds[0], translation: 'עכבר', saved: true });
    expect(word.senses[0].examples).toHaveLength(2);
  });

  it('headlines the key of a word saved from an inflected form, and says where it was saved from', async () => {
    const palets = await insertLexeme(t.db, {
      lemma: 'палец',
      languageCode: 'ru',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'digit' }],
      variants: [
        {
          form: 'палец',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבע', exampleSource: null, exampleTarget: null }],
        },
        {
          form: 'пальцы',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבעות', gloss: 'אצבע', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    // The lemma form is rendered, so from Task 10 on this save asks for no job.
    expect((await save(RU, [{ gloss_id: palets.glossIds[0], variant_id: palets.variantIds[1] }])).status).toBe(200);

    const page = (await (await list(RU)).json()) as Page;
    expect(page.items[0]).toMatchObject({ lemma: 'палец', headline: { translation: 'אצבע', form: 'пальцы' } });
    const word = (await (await detail(RU, 'палец')).json()) as Detail;
    expect(word.senses[0]).toMatchObject({ translation: 'אצבע', saved_from: { form: 'пальцы', translation: 'אצבעות' } });
  });
});
