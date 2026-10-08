import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createTranslationsRouter } from '../../../src/routes/translations';
import { ACT_AS, actAs } from '../../support/actAs';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedLegacyLearner, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
const RU = 'e_ru';

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedEnrollment(t.db, { id: RU, userId: 'u_1', targetLanguage: 'ru' });
});
afterEach(async () => {
  await t.close();
});

function deps() {
  return createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
}

// Acts as RU's owner unless a case says otherwise.
function translate(body: unknown, actor = 'u_1') {
  const app = new Hono();
  const d = deps();
  app.use('*', actAs());
  app.route('/api', createTranslationsRouter(d.translations, d.logger));
  return app.request('/api/translations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ACT_AS]: actor },
    body: JSON.stringify(body),
  });
}

type Sense = { translation: string; sense_id?: string; variant_id?: string; saved?: boolean };

async function rama() {
  return insertLexeme(t.db, {
    lemma: 'рама',
    languageCode: 'ru',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'window' }, { senseCode: 'gap' }],
    variants: [
      {
        form: 'рама',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'window', rank: 0, translation: 'חלון', exampleSource: null, exampleTarget: null },
          { senseCode: 'gap', rank: 1, translation: 'חלון זמן', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
}

describe('POST /api/translations with an enrollment', () => {
  it('carries ids on every stored sense, and saved flags for a target-language lookup', async () => {
    const ids = await rama();
    await deps().vocabulary.save('u_1', RU, [{ sense_id: ids.senseIds[1], variant_id: ids.variantIds[0] }]);

    const res = await translate({ text: 'рама', from: 'ru', to: 'he', enrollment_id: RU });
    expect(res.status).toBe(200);
    const { senses } = (await res.json()) as { senses: Sense[] };
    expect(senses).toEqual([
      { translation: 'חלון', part_of_speech: 'noun', sense_id: ids.senseIds[0], variant_id: ids.variantIds[0], saved: false },
      { translation: 'חלון זמן', part_of_speech: 'noun', sense_id: ids.senseIds[1], variant_id: ids.variantIds[0], saved: true },
    ]);
  });

  it('carries ids but no saved flag without an enrollment', async () => {
    await rama();
    const { senses } = (await (await translate({ text: 'рама', from: 'ru', to: 'he' })).json()) as {
      senses: Sense[];
    };
    expect(senses[0].sense_id).toEqual(expect.any(String));
    expect(senses[0]).not.toHaveProperty('saved');
  });

  it('carries no saved flag on a reverse lookup', async () => {
    await insertLexeme(t.db, {
      lemma: 'חלון',
      languageCode: 'he',
      partOfSpeech: 'noun',
      userLanguageCode: 'ru',
      senses: [{ senseCode: 'window' }],
      variants: [
        {
          form: 'חלון',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'window', rank: 0, translation: 'рама', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const { senses } = (await (
      await translate({ text: 'חלון', from: 'he', to: 'ru', enrollment_id: RU })
    ).json()) as { senses: Sense[] };
    expect(senses).toHaveLength(1);
    // Ids are present, so the missing flag is down to from ≠ target, not to a
    // sense the lookup could not identify.
    expect(senses[0].sense_id).toEqual(expect.any(String));
    expect(senses[0].variant_id).toEqual(expect.any(String));
    expect(senses[0]).not.toHaveProperty('saved');
  });

  // Done-means #3: `saved` belongs to the sense, not to the form it was saved from.
  it('marks a sense saved from one form when another form of the word is looked up', async () => {
    const ids = await insertLexeme(t.db, {
      lemma: 'рама',
      languageCode: 'ru',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'window' }],
      variants: [
        {
          form: 'рама',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'window', rank: 0, translation: 'חלון', exampleSource: null, exampleTarget: null },
          ],
        },
        {
          form: 'рамы',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'window', rank: 0, translation: 'חלונות', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    await deps().vocabulary.save('u_1', RU, [{ sense_id: ids.senseIds[0], variant_id: ids.variantIds[0] }]);

    const res = await translate({ text: 'рамы', from: 'ru', to: 'he', enrollment_id: RU });
    expect(res.status).toBe(200);
    const { senses } = (await res.json()) as { senses: Sense[] };
    expect(senses).toHaveLength(1);
    expect(senses[0]).toMatchObject({
      sense_id: ids.senseIds[0],
      variant_id: ids.variantIds[1],
      translation: 'חלונות',
      saved: true,
    });
  });

  it('answers 404 for an unknown enrollment, before any lookup', async () => {
    const res = await translate({ text: 'рама', from: 'ru', to: 'he', enrollment_id: 'e_nobody' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });

  // Phase 29 (spec D13). `saved` reads the list, so only its owner may name it.
  // `окно` is in no seed and no lexeme here, and the default Gemini URL is
  // unroutable: a check moved after the lookup would answer 502, not 403.
  it("answers 403 for another learner's enrollment, before any lookup or model call", async () => {
    await seedUser(t.db, 'u_2');
    const res = await translate({ text: 'окно', from: 'ru', to: 'he', enrollment_id: RU }, 'u_2');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  // `casement` is in no seed and no lexeme this test inserts, and no MockServer
  // expectation is registered (serverDeps' default Gemini URL is unroutable). A
  // check moved after the lookup would miss the cache, reach the model path and
  // answer 502, not 400. A seeded word like `window` would hit the cache and
  // answer 400 either way, proving nothing.
  it("answers 400 for a pair that is not the enrollment's, before any lookup or model call", async () => {
    const res = await translate({ text: 'casement', from: 'en', to: 'he', enrollment_id: RU });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'pair not enrolled' });
  });

  // Review Focus 4: the rule is "from is the enrollment's target", not "to is he".
  it('marks saved for a legacy English-explained enrollment on a he → en lookup', async () => {
    const { enrollmentId } = await seedLegacyLearner(t.db);
    const sefer = await insertLexeme(t.db, {
      lemma: 'ספר',
      languageCode: 'he',
      partOfSpeech: 'noun',
      userLanguageCode: 'en',
      senses: [{ senseCode: 'book' }],
      variants: [
        {
          form: 'ספר',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'book', rank: 0, translation: 'book', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    await deps().vocabulary.save('u_legacy', enrollmentId, [
      { sense_id: sefer.senseIds[0], variant_id: sefer.variantIds[0] },
    ]);
    const { senses } = (await (
      await translate({ text: 'ספר', from: 'he', to: 'en', enrollment_id: enrollmentId }, 'u_legacy')
    ).json()) as { senses: Sense[] };
    expect(senses[0].saved).toBe(true);
  });
});
