import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createVocabularyRouter } from '../../../src/routes/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
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

const save = (enrollmentId: string, entries: unknown) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
const unsave = (enrollmentId: string, senseId: string) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary/senses/${senseId}`, { method: 'DELETE' });
const list = (enrollmentId: string, query = '') =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary${query}`);
const detail = (enrollmentId: string, lexemeId: string) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary/words/${lexemeId}`);

type Page = { items: { lexeme_id: string; saved_count: number; sense_count: number }[]; next_cursor: string | null };

describe('POST /api/enrollments/{id}/vocabulary', () => {
  it('saves a sense, and the list shows its word', async () => {
    const rama = await russianWord('рама');
    const res = await save(RU, [{ sense_id: rama.senseIds[0], variant_id: rama.variantIds[0] }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_sense_ids: [rama.senseIds[0]] });

    const page = (await (await list(RU)).json()) as Page;
    expect(page.items).toEqual([
      {
        lexeme_id: rama.lexemeId,
        lemma: 'рама',
        part_of_speech: 'noun',
        headline: { sense_id: rama.senseIds[0], translation: 'рама-1', form: 'рама' },
        saved_count: 1,
        sense_count: 2,
        level: 1,
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
      { sense_id: rama.senseIds[0], variant_id: rama.variantIds[0] },
      { sense_id: english.senseIds[0], variant_id: english.variantIds[0] },
    ]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid vocabulary entry' });
    // The body names nothing; the log names the refused sense (spec §4).
    expect(logger.events).toContainEqual({
      event: 'vocabulary_entry_refused',
      enrollment_id: RU,
      sense_id: english.senseIds[0],
      variant_id: english.variantIds[0],
    });
    expect(((await (await list(RU)).json()) as Page).items).toEqual([]);
  });

  // Review Focus 1.
  it('saves a sense sent twice in one batch once, with 200', async () => {
    const rama = await russianWord('рама');
    const entry = { sense_id: rama.senseIds[0], variant_id: rama.variantIds[0] };
    const res = await save(RU, [entry, entry]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_sense_ids: [rama.senseIds[0]] });
    expect(((await (await list(RU)).json()) as Page).items[0].saved_count).toBe(1);
  });

  it('answers 404 for an unknown enrollment', async () => {
    const rama = await russianWord('рама');
    const res = await save('e_nobody', [{ sense_id: rama.senseIds[0], variant_id: rama.variantIds[0] }]);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });

  it.each([
    ['no entries', []],
    ['twenty-one entries', Array(21).fill({ sense_id: 's', variant_id: 'v' })],
  ])('answers 400 for %s', async (_label, entries) => {
    const res = await save(RU, entries);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});

describe('DELETE /api/enrollments/{id}/vocabulary/senses/{sense_id}', () => {
  it('unsaves, idempotently', async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ sense_id: rama.senseIds[0], variant_id: rama.variantIds[0] }]);
    expect((await unsave(RU, rama.senseIds[0])).status).toBe(204);
    expect((await unsave(RU, rama.senseIds[0])).status).toBe(204);
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
    const forged = Buffer.from(JSON.stringify(['2026-13-45 25:61:00+00', 'lx-1']), 'utf8').toString(
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
    await save(RU, [{ sense_id: rama.senseIds[0], variant_id: rama.variantIds[0] }]);
    expect(((await (await list('e_u_1')).json()) as Page).items).toEqual([]);
  });

  describe('a 120-word walk in pages of 50', () => {
    let words: Awaited<ReturnType<typeof russianWord>>[];

    beforeEach(async () => {
      words = [];
      for (let i = 0; i < 120; i += 1) {
        const word = await russianWord(`слово${i}`);
        await save(RU, [{ sense_id: word.senseIds[0], variant_id: word.variantIds[0] }]);
        words.push(word);
      }
    }, 60_000);

    async function walk(onPage?: (n: number) => Promise<void>): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; ; n += 1) {
        const query = `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = (await (await list(RU, query)).json()) as Page;
        seen.push(...page.items.map((item) => item.lexeme_id));
        if (onPage) await onPage(n);
        if (!page.next_cursor) return seen;
        cursor = page.next_cursor;
      }
    }

    it('returns every word exactly once, newest first', async () => {
      const seen = await walk();
      expect(seen).toHaveLength(120);
      expect(seen[0]).toBe(words[119].lexemeId);
      expect(seen[119]).toBe(words[0].lexemeId);
      expect(new Set(seen).size).toBe(120);
    });

    it('neither duplicates nor loses a word when an old one moves to the top mid-walk', async () => {
      const moved = words[10];
      const seen = await walk(async (n) => {
        if (n === 0) {
          await save(RU, [{ sense_id: moved.senseIds[1], variant_id: moved.variantIds[0] }]);
        }
      });
      // The moved word is now before the cursor: this walk does not see it again,
      // and sees every other word exactly once.
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain(moved.lexemeId);
      // A refresh starts with it.
      const fresh = (await (await list(RU, '?limit=1')).json()) as Page;
      expect(fresh.items[0]).toMatchObject({ lexeme_id: moved.lexemeId, saved_count: 2 });
    });

    it("drops a word whose last sense is unsaved", async () => {
      await unsave(RU, words[50].senseIds[0]);
      const seen = await walk();
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain(words[50].lexemeId);
    });
  });
});

describe('GET /api/enrollments/{id}/vocabulary/words/{lexeme_id}', () => {
  it('lists every sense, saved first, and answers 200 once nothing is saved', async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ sense_id: rama.senseIds[1], variant_id: rama.variantIds[0] }]);

    const res = await detail(RU, rama.lexemeId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { senses: { sense_id: string; saved: boolean }[] };
    expect(body.senses.map((s) => [s.sense_id, s.saved])).toEqual([
      [rama.senseIds[1], true],
      [rama.senseIds[0], false],
    ]);

    await unsave(RU, rama.senseIds[1]);
    expect((await detail(RU, rama.lexemeId)).status).toBe(200);
  });

  it("answers 404 for an unknown lexeme and for one outside the enrollment's target", async () => {
    const rama = await russianWord('рама');
    expect((await detail(RU, 'nope')).status).toBe(404);
    const wrongLanguage = await detail('e_u_1', rama.lexemeId);
    expect(wrongLanguage.status).toBe(404);
    expect(await wrongLanguage.json()).toEqual({ error: 'word not found' });
  });

  it('answers 404 for an unknown enrollment', async () => {
    const rama = await russianWord('рама');
    const res = await detail('e_nobody', rama.lexemeId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });
});

describe('levels on the list (phase 20)', () => {
  type Leveled = { items: { lexeme_id: string; level: number }[]; next_cursor: string | null };
  const ids = async (query: string) => ((await (await list(RU, query)).json()) as Leveled).items.map((i) => i.lexeme_id);

  async function savedWord(lemma: string, level: number) {
    const word = await russianWord(lemma);
    await save(RU, [{ sense_id: word.senseIds[0], variant_id: word.variantIds[0] }]);
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[0], level });
    return word.lexemeId;
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
    const id = await savedWord('арка', 1);
    expect(((await (await list(RU)).json()) as Leveled).items).toEqual([
      expect.objectContaining({ lexeme_id: id, level: 1 }),
    ]);
  });

  it("averages a word's saved senses, rounding a tie up", async () => {
    const word = await russianWord('рама');
    await save(RU, word.senseIds.map((senseId) => ({ sense_id: senseId, variant_id: word.variantIds[0] })));
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[0], level: 2 });
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[1], level: 3 });
    expect(((await (await list(RU)).json()) as Leveled).items[0].level).toBe(3);
  });

  it('sorts by level both ways, the newer save first within a level', async () => {
    const low = await savedWord('арка', 1);
    const highOld = await savedWord('бак', 4);
    const highNew = await savedWord('вал', 4);
    const mid = await savedWord('газ', 2);
    expect(await ids('?sort=level_desc')).toEqual([highNew, highOld, mid, low]);
    expect(await ids('?sort=level_asc')).toEqual([low, mid, highNew, highOld]);
  });

  it('filters to one level', async () => {
    await savedWord('арка', 1);
    const highOld = await savedWord('бак', 4);
    const highNew = await savedWord('вал', 4);
    expect(await ids('?level=4')).toEqual([highNew, highOld]);
    expect(await ids('?level=3')).toEqual([]);
  });

  it('walks a level sort page by page without repeating or losing a word', async () => {
    for (let i = 0; i < 12; i += 1) await savedWord(`слово${i}`, (i % 5) + 1);
    const seen = await walk('?sort=level_asc&limit=5');
    expect(seen).toHaveLength(12);
    expect(new Set(seen.map((item) => item.lexeme_id)).size).toBe(12);
    expect(seen.map((item) => item.level)).toEqual([...seen.map((item) => item.level)].sort((a, b) => a - b));
  });

  // Review Focus 4: a filtered, level-sorted walk.
  it('walks a filtered level sort page by page', async () => {
    for (let i = 0; i < 9; i += 1) await savedWord(`слово${i}`, i % 3 === 0 ? 2 : 1);
    const seen = await walk('?sort=level_desc&level=2&limit=2');
    expect(seen).toHaveLength(3);
    expect(seen.every((item) => item.level === 2)).toBe(true);
    expect(new Set(seen.map((item) => item.lexeme_id)).size).toBe(3);
  });

  it('answers 400 for a cursor replayed under another sort', async () => {
    for (let i = 0; i < 3; i += 1) await savedWord(`слово${i}`, 1);
    const page = (await (await list(RU, '?limit=1')).json()) as Leveled;
    const res = await list(RU, `?sort=level_asc&cursor=${encodeURIComponent(page.next_cursor!)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it.each(['?sort=oldest', '?level=0', '?level=6', '?level=two'])('answers 400 for %s', async (query) => {
    const res = await list(RU, query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});
