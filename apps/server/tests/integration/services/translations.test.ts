import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  countGeminiRequests,
  expectGeminiJson,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Black-box: production's assembly with a per-test database and this test's own
// MockServer namespace. The real Gemini client makes a real HTTP request over a
// real socket, and nothing is faked inside the server.
//
// Every string here is one the seed does not contain — a seeded string answers
// from Postgres and never reaches MockServer.

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('services-translations');
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

function translations() {
  return createTestServerDeps({
    db: t.db,
    logger: createFakeLogger(),
    rng: testRng(7),
    geminiBaseUrl: geminiBaseUrlFor(ns),
  }).translations;
}

const entry = (lemma: string, values: string[]) => ({
  lemma,
  senses: values.map((translation, n) => ({
    translation,
    part_of_speech: 'verb',
    example: { source: `A sentence about ${lemma}.`, target: 'משפט.' },
    sense_code: `${lemma}_${n}`,
  })),
});

describe('translate, against a real database', () => {
  it('asks the provider once for two lookups of the same string', async () => {
    await expectGeminiJson(ns, { kind: 'word', entries: [entry('ladder', ['סולם', 'דירוג'])] });
    const service = translations();

    const first = await service.translate({ text: 'ladder' });
    const second = await service.translate({ text: 'ladder' });

    expect(second).toEqual(first);
    expect(await countGeminiRequests(ns, 'ladder')).toBe(1);
  });

  it('serves a different casing and spacing of the same string from the dictionary', async () => {
    await expectGeminiJson(ns, { kind: 'word', entries: [entry('ladder', ['סולם'])] });
    const service = translations();

    await service.translate({ text: 'ladder' });
    const again = await service.translate({ text: '  LADDER  ' });

    expect(again.senses).toEqual([
      { translation: 'סולם', part_of_speech: 'verb', example: { source: 'A sentence about ladder.', target: 'משפט.' } },
    ]);
    // Deviation from the brief, confirmed by experiment: MockServer's REGEX
    // body match is case-insensitive by default (verified directly against
    // this container — a body containing "apples" matches a retrieve filter
    // of "APPLES"). `countGeminiRequests(ns, 'LADDER')` would therefore also
    // count the first, lower-case request, so `.toBe(0)` is false regardless
    // of whether the second lookup reached the provider — it is not a signal
    // of Task 6/7 behaviour. Asserting the total for 'ladder' is exactly 1
    // proves the same thing the brief intended (the second, differently-cased
    // and spaced lookup added no request) without relying on case-sensitivity
    // MockServer does not provide.
    expect(await countGeminiRequests(ns, 'ladder')).toBe(1);
  });

  it('walks the saw sequence end to end', async () => {
    // Registration order matters: MockServer takes the first matching
    // expectation, and the body for `saws` also contains `saw`.
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [entry('saw', ['מסור', 'לנסר'])],
      matchText: 'saws',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [entry('see', ['לראות', 'להבין', 'לפגוש']), entry('saw', ['מסור', 'לנסר'])],
      matchText: 'saw',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [entry('see', ['לראות', 'להבין', 'לפגוש'])],
      matchText: 'see',
    });
    const service = translations();

    // 1 — `see` on an empty dictionary: its own three.
    const see = await service.translate({ text: 'see' });
    expect(see.senses.map((sense) => sense.translation)).toEqual(['לראות', 'להבין', 'לפגוש']);

    // 2 — `saw`: both headwords answered and both written, in one call.
    const saw = await service.translate({ text: 'saw' });
    expect(saw.senses.map((sense) => sense.translation)).toEqual([
      'לראות',
      'מסור',
      'להבין',
      'לנסר',
      'לפגוש',
    ]);

    // 3 — the same lookup again is free and identical.
    expect(await service.translate({ text: 'saw' })).toEqual(saw);
    expect(await countGeminiRequests(ns, '"saw"')).toBe(1);

    // 4 — `saws` is a second call, because no lemma alias was synthesized.
    const saws = await service.translate({ text: 'saws' });
    expect(saws.senses.map((sense) => sense.translation)).toEqual(['מסור', 'לנסר']);

    // 5 — `see` still answers with its own three. Correctly no מסור: `see` is
    // not ambiguous, even though `saw` is.
    expect(await service.translate({ text: 'see' })).toEqual(see);
  });

  it('keeps costing for a sentence, because a sentence is not a vocabulary item', async () => {
    await expectGeminiJson(ns, {
      kind: 'sentence',
      entries: [
        {
          lemma: 'I climbed the ladder',
          senses: [{ translation: 'טיפסתי על הסולם.', sense_code: 'the_sentence' }],
        },
      ],
    });
    const service = translations();

    await service.translate({ text: 'I climbed the ladder' });
    await service.translate({ text: 'I climbed the ladder' });

    expect(await countGeminiRequests(ns, 'climbed')).toBe(2);
  });

  it('keeps costing for an answer with no entries', async () => {
    await expectGeminiJson(ns, { kind: 'word', entries: [] });
    const service = translations();

    await service.translate({ text: 'asdkjhasd' });
    await service.translate({ text: 'asdkjhasd' });

    expect(await countGeminiRequests(ns, 'asdkjhasd')).toBe(2);
  });
});
