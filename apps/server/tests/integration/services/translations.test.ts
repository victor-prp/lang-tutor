import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PartOfSpeech } from '@lang-tutor/core/api';

import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  countGeminiRequests,
  expectGeminiJson,
  expectGeminiStatus,
  expectReconciliation,
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

// An entry is a lexeme from phase 12 on: the part of speech is on the entry,
// not repeated on each of its senses.
const entry = (lemma: string, values: string[], partOfSpeech: PartOfSpeech = 'verb') => ({
  lemma,
  part_of_speech: partOfSpeech,
  senses: values.map((translation, n) => ({
    translation,
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

  // Phase 13. `book?` was a different dictionary key from `book`, so a trailing
  // keystroke bought a second provider call and a second permanent copy of the
  // word — the dev database held `book` with three senses and `book?` with
  // four. The sibling of the casing-and-spacing case above, and it asserts the
  // same two things: the answer comes back, and the provider was not asked.
  it('serves a punctuated spelling of the same word from the dictionary', async () => {
    await expectGeminiJson(ns, { kind: 'word', entries: [entry('ladder', ['סולם'])] });
    const service = translations();

    await service.translate({ text: 'ladder' });
    const again = await service.translate({ text: 'ladder?' });

    expect(again.senses).toEqual([
      {
        translation: 'סולם',
        part_of_speech: 'verb',
        example: { source: 'A sentence about ladder.', target: 'משפט.' },
      },
    ]);
    // The key is normalized; what the learner typed is still what comes back.
    expect(again.text).toBe('ladder?');
    // A request body for `ladder?` contains `ladder`, so a second provider call
    // would push this to 2 — which is exactly what makes 1 the proof.
    expect(await countGeminiRequests(ns, 'ladder')).toBe(1);
  });

  it('walks the saw sequence end to end', async () => {
    // Phase 12 adds a SECOND provider call wherever the lexeme an entry names
    // already has senses, so this sequence now needs two reconciliation
    // answers: one when `saw` reaches the `see` lexeme written at step 1, and
    // one when `saws` reaches the `saw` lexeme written at step 2.
    //
    // Matched on the QUOTED form, which appears verbatim in the user part of
    // the request body. Unquoted `saw` would also match a `saws` body — the
    // trap the first-matching-expectation note below is about — while `"saw"`
    // cannot, because `"saws"` has an `s` where the closing quote would be.
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'see_0', translation: 'לראות' },
        { sense_code: 'see_1', translation: 'להבין' },
        { sense_code: 'see_2', translation: 'לפגוש' },
      ],
      matchText: '"saw"',
    });
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'saw_0', translation: 'מסור' },
        { sense_code: 'saw_1', translation: 'לנסר' },
      ],
      matchText: '"saws"',
    });

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
    // Two, not one: step 2 cost a first call AND a reconciliation call, because
    // the `see` lexeme it named already had senses from step 1. The point of the
    // assertion is unchanged — this third lookup added neither.
    expect(await countGeminiRequests(ns, '"saw"')).toBe(2);

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
          part_of_speech: 'verb',
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

  // The phase's most important test. Two independent lookups of one lexeme are
  // two independent model calls that name the same sense differently, so a
  // string comparison on sense_code would store the meaning twice — and the
  // dictionary has no TTL, so twice is forever.
  //
  // **Proved without reading a row.** ADR 0001 R2 keeps this bucket black-box,
  // and the wire cannot tell the two outcomes apart: `banks` answers with its
  // own two renderings either way. What differs is what the NEXT form is told.
  // The reconciliation prompt lists the lexeme's stored senses, so a third
  // lookup makes the stored state observable through MockServer: if `river_edge`
  // was ever written, it appears in that prompt.
  it('reconciles a renamed sense instead of duplicating it', async () => {
    // Registration order matters, twice over. MockServer takes the FIRST
    // matching expectation, and `banks` contains `bank`. Matching on the QUOTED
    // form sidesteps it: the form appears verbatim in the request's user part,
    // and `"bank"` cannot match `"banks"` because there is an `s` where the
    // closing quote would be.
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'financial_institution', translation: 'BANKS-FIN' },
        { sense_code: 'river_bank', translation: 'BANKS-RIVER' }, // the STORED code, reused
      ],
      matchText: '"banks"',
    });
    await expectReconciliation(ns, {
      senses: [{ sense_code: 'financial_institution', translation: 'BANKED-FIN' }],
      matchText: '"banked"',
    });

    const noun = (senses: { translation: string; sense_code: string }[]) => ({
      kind: 'word' as const,
      entries: [{ lemma: 'bank', part_of_speech: 'noun' as const, senses }],
    });

    // call 1 for `bank` — two senses, one of them named river_bank
    await expectGeminiJson(ns, {
      ...noun([
        { translation: 'BANK-FIN', sense_code: 'financial_institution' },
        { translation: 'BANK-RIVER', sense_code: 'river_bank' },
      ]),
      matchText: '"bank"',
    });
    // call 1 for `banks` names the SAME sense river_edge; call 2 maps it back.
    await expectGeminiJson(ns, {
      ...noun([
        { translation: 'BANKS-FIN', sense_code: 'financial_institution' },
        { translation: 'BANKS-RIVER', sense_code: 'river_edge' },
      ]),
      matchText: '"banks"',
    });
    await expectGeminiJson(ns, {
      ...noun([{ translation: 'BANKED-FIN', sense_code: 'financial_institution' }]),
      matchText: '"banked"',
    });

    const service = translations();
    await service.translate({ text: 'bank' });
    const answer = await service.translate({ text: 'banks' });
    await service.translate({ text: 'banked' });

    expect(answer.senses.map((x) => x.translation)).toEqual(['BANKS-FIN', 'BANKS-RIVER']);

    // Two reconciliation prompts really were sent — one for `banks`, one for
    // `banked` — so the second one did list this lexeme's stored senses. That
    // is what makes the next assertion mean something rather than pass
    // vacuously because no such prompt exists.
    expect(await countGeminiRequests(ns, 'reusing its sense_code EXACTLY')).toBe(2);

    // And it never named river_edge. The prompt lists every stored sense, so if
    // the renaming had been taken at face value and written as a third sense, it
    // would be in this body. The meaning is stored once.
    expect(await countGeminiRequests(ns, 'river_edge')).toBe(0);
  });

  // F5. `scan` is not in the seed. Registration order matters: the
  // reconciliation prompts also carry the quoted form, so they are registered
  // first — see the `bank`/`banks` case above.
  //
  // NOT the file's `entry()` helper. That generates `sense_code: scan_0`,
  // `scan_1`, so the first lookup would store codes the reconciliation
  // responses below never name — reconciliation would treat all three as NEW
  // and the lexeme would end up with five senses instead of three, quietly
  // testing nothing.
  const scanVerb = (senses: { translation: string; sense_code: string }[]) => ({
    kind: 'word' as const,
    entries: [{ lemma: 'scan', part_of_speech: 'verb' as const, senses }],
  });

  it('re-renders a form once its lexeme has learned a new sense', async () => {
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'read_quickly', translation: 'SCANS-READ' },
        { sense_code: 'examine_closely', translation: 'SCANS-EXAMINE' },
        { sense_code: 'digitize_image', translation: 'SCANS-DIGITIZE' },
      ],
      matchText: '"scans"',
    });
    // The repair call for `scan`: same prompt, same shape, now listing three.
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'read_quickly', translation: 'SCAN-READ' },
        { sense_code: 'digitize_image', translation: 'SCAN-DIGITIZE' },
        { sense_code: 'examine_closely', translation: 'SCAN-EXAMINE' },
      ],
      matchText: '"scan"',
    });
    await expectGeminiJson(ns, {
      ...scanVerb([
        { translation: 'SCANS-READ', sense_code: 'read_quickly' },
        { translation: 'SCANS-EXAMINE', sense_code: 'examine_closely' },
        { translation: 'SCANS-DIGITIZE', sense_code: 'digitize_image' },
      ]),
      matchText: '"scans"',
    });
    await expectGeminiJson(ns, {
      ...scanVerb([
        { translation: 'SCAN-READ', sense_code: 'read_quickly' },
        { translation: 'SCAN-EXAMINE', sense_code: 'examine_closely' },
      ]),
      matchText: '"scan"',
    });

    const service = translations();

    const first = await service.translate({ text: 'scan' });
    expect(first.senses.map((s) => s.translation)).toEqual(['SCAN-READ', 'SCAN-EXAMINE']);

    await service.translate({ text: 'scans' });

    // The repair: three senses, and re-RANKED by the repair call rather than
    // appended at the end. digitize_image comes second because that is where
    // this form ranked it, which is the whole reason rank lives on the
    // translation.
    const healed = await service.translate({ text: 'scan' });
    expect(healed.senses.map((s) => s.translation)).toEqual([
      'SCAN-READ',
      'SCAN-DIGITIZE',
      'SCAN-EXAMINE',
    ]);

    // And the repair is paid once. A fourth lookup is a plain hit.
    const afterRepair = await countGeminiRequests(ns);
    expect(await service.translate({ text: 'scan' })).toEqual(healed);
    expect(await countGeminiRequests(ns)).toBe(afterRepair);
  });

  // A failed repair must not fail the request: nothing was written, so the
  // stored answer stands. The opposite of the reconciliation call's fail-closed
  // rule, and for the opposite reason — see the spec's "When the repair fails".
  it('serves the older answer when the repair call fails', async () => {
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'read_quickly', translation: 'SCANS-READ' },
        { sense_code: 'examine_closely', translation: 'SCANS-EXAMINE' },
        { sense_code: 'digitize_image', translation: 'SCANS-DIGITIZE' },
      ],
      matchText: '"scans"',
    });
    await expectGeminiJson(ns, {
      ...scanVerb([
        { translation: 'SCANS-READ', sense_code: 'read_quickly' },
        { translation: 'SCANS-EXAMINE', sense_code: 'examine_closely' },
        { translation: 'SCANS-DIGITIZE', sense_code: 'digitize_image' },
      ]),
      matchText: '"scans"',
    });
    await expectGeminiJson(ns, {
      ...scanVerb([
        { translation: 'SCAN-READ', sense_code: 'read_quickly' },
        { translation: 'SCAN-EXAMINE', sense_code: 'examine_closely' },
      ]),
      matchText: '"scan"',
    });

    // This test needs the logger it asserts on, so it builds its deps itself
    // rather than calling the file's `translations()` helper, which makes a
    // fresh fake logger and drops it.
    const logger = createFakeLogger();
    const service = createTestServerDeps({
      db: t.db, logger, rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns),
    }).translations;

    await service.translate({ text: 'scan' });   // two senses
    await service.translate({ text: 'scans' });  // the lexeme learns a third

    // Now the repair is due — and the provider is down for it.
    await clearNamespace(ns);
    await expectGeminiStatus(ns, 503);

    const answer = await service.translate({ text: 'scan' });

    // 200, with the stored answer. Nothing was written, so nothing was lost.
    expect(answer.senses.map((s) => s.translation)).toEqual(['SCAN-READ', 'SCAN-EXAMINE']);
    expect(logger.errors).toContainEqual(
      expect.objectContaining({ message: 'dict_repair_failed' }),
    );
  });
});
