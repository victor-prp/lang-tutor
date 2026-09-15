import { describe, expect, it } from '@jest/globals';

import {
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  createFakeDictRepo,
} from '../../tests/support/fakes';
import type { SenseRow } from '../domain/dictionary';
import { LlmUnavailable, TranslationUnreadable } from '../errors';
import type { CorrectionRow } from '../repo/dictionary';
import { createTranslationService } from './translations';

const reply = (payload: unknown) => JSON.stringify(payload);

/** One entry, for the many tests that do not care about the nesting. An entry is
 *  a lexeme from phase 12 on, so it carries a part of speech whether or not the
 *  test is about one. */
const oneEntry = (lemma: string, senses: Record<string, unknown>[], pos = 'noun') => ({
  entries: [{ lemma, part_of_speech: pos, senses }],
});

function serviceWith(...replies: (string | Error)[]) {
  const llm = createFakeLlmClient(...replies);
  const logger = createFakeLogger();
  const dict = createFakeDictRepo();
  const transaction = createFakeTransaction({ dict });
  return { service: createTranslationService({ llm, transaction, logger }), llm, logger, dict };
}

const row = (translation: string, over: Partial<SenseRow> = {}): SenseRow => ({
  lexemeId: 't-1',
  rank: 0,
  entryRank: 0,
  partOfSpeech: null,
  exampleSource: null,
  translation,
  exampleTarget: null,
  kind: 'word',
  ...over,
});

describe('translate', () => {
  it('detects the direction and echoes the trimmed text back', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('book', [{ translation: 'ספר', sense_code: 'printed_book' }]),
      }),
    );

    const result = await service.translate({ text: '  book  ' });

    expect(result.text).toBe('book');
    expect(result.direction).toBe('en_he');
  });

  it('honours an explicit direction, which is what the flip control sends', async () => {
    const { service, llm } = serviceWith(reply({ kind: 'word', entries: [] }));

    const result = await service.translate({ text: 'book', direction: 'he_en' });

    expect(result.direction).toBe('he_en');
    expect(llm.calls[0].system).toContain('Hebrew to English');
  });

  it('passes the prompt straight through to the client', async () => {
    const { service, llm } = serviceWith(reply({ kind: 'word', entries: [] }));

    await service.translate({ text: 'book' });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toBe('book');
    expect(typeof llm.calls[0].schema.safeParse).toBe('function');
  });

  it('overrides the model when a single token is called a sentence', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'sentence',
        ...oneEntry('book', [{ translation: 'ספר', sense_code: 'printed_book' }]),
      }),
    );

    const result = await service.translate({ text: 'book' });

    expect(result.kind).toBe('word');
  });

  it('reduces a real sentence to one bare sense', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'sentence',
        ...oneEntry(
          'I read a book',
          [
            { translation: 'קראתי ספר.', example: { source: 'a', target: 'b' }, sense_code: 's' },
            { translation: 'אחר', sense_code: 't' },
          ],
          'verb',
        ),
      }),
    );

    const result = await service.translate({ text: 'I read a book' });

    expect(result.kind).toBe('sentence');
    expect(result.senses).toEqual([{ translation: 'קראתי ספר.' }]);
  });

  it('treats no content as an empty result rather than a failure', async () => {
    const { service, logger } = serviceWith('');

    const result = await service.translate({ text: 'asdkjhasd' });

    expect(result.senses).toEqual([]);
    expect(logger.events.map((event) => event.event)).toContain('translation_no_content');
  });

  it('treats an empty sense list from the model as an empty result', async () => {
    const { service } = serviceWith(reply({ kind: 'word', entries: [] }));
    await expect(service.translate({ text: 'asdkjhasd' })).resolves.toMatchObject({ senses: [] });
  });

  it('raises TranslationUnreadable for output that does not match the schema', async () => {
    const { service } = serviceWith('I cannot help with that.');
    await expect(service.translate({ text: 'book' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
  });

  it('truncates the excerpt it carries, so a log line cannot be flooded', async () => {
    const { service } = serviceWith('x'.repeat(5000));
    await expect(service.translate({ text: 'book' })).rejects.toMatchObject({
      rawExcerpt: expect.stringMatching(/^x{200}$/),
    });
  });

  it('lets LlmUnavailable through untouched', async () => {
    const { service } = serviceWith(new LlmUnavailable('responded 500'));
    await expect(service.translate({ text: 'book' })).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('flattens two entries into one ranked list, round-robin by rank', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          {
            lemma: 'see',
            part_of_speech: 'verb',
            senses: [
              { translation: 'לראות', sense_code: 'perceive' },
              { translation: 'להבין', sense_code: 'understand' },
            ],
          },
          {
            lemma: 'saw',
            part_of_speech: 'noun',
            senses: [{ translation: 'מסור', sense_code: 'tool' }],
          },
        ],
      }),
    );

    const result = await service.translate({ text: 'saw' });

    expect(result.senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור', 'להבין']);
    expect(result.senses[0]).not.toHaveProperty('sense_code');
  });

  it('serves a hit from the database and calls the model zero times', async () => {
    const { service, llm, dict, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    dict.hit = { ladder: [row('סולם')] };

    const result = await service.translate({ text: 'ladder' });

    expect(llm.calls).toHaveLength(0);
    expect(result.senses).toEqual([{ translation: 'סולם' }]);
    expect(logger.events[0]).toEqual({
      event: 'dict_cache_hit',
      direction: 'en_he',
      term_count: 1,
      sense_count: 1,
    });
  });

  it('answers a hit with the kind the row actually stored, not a re-derived guess', async () => {
    // `to remember` has whitespace, so re-deriving from the text alone
    // (resolveKind's single-token override never firing) would answer
    // `phrase` regardless of what was written. The stored row says `word`,
    // recorded that way by the entry_rank 0 variant, and the hit path must
    // honour it rather than guess.
    const { service, dict } = serviceWith(reply({ kind: 'word', entries: [] }));
    dict.hit = { 'to remember': [row('לזכור', { kind: 'word' })] };

    const result = await service.translate({ text: 'to remember' });

    expect(result.kind).toBe('word');
  });

  it('reads with the normalized form and the direction\'s language pair', async () => {
    const { service, dict } = serviceWith(reply({ kind: 'word', entries: [] }));

    await service.translate({ text: '  good   morning ' });

    expect(dict.reads[0]).toEqual({
      form: 'good morning',
      languageCode: 'en',
      userLanguageCode: 'he',
    });
  });

  it('writes every entry on a miss, with the queried form and the resolved kind', async () => {
    const { service, llm, dict } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          {
            lemma: 'see',
            part_of_speech: 'verb',
            senses: [{ translation: 'לראות', sense_code: 'perceive' }],
          },
          {
            lemma: 'saw',
            part_of_speech: 'noun',
            senses: [{ translation: 'מסור', sense_code: 'tool' }],
          },
        ],
      }),
    );

    await service.translate({ text: 'saw' });

    expect(llm.calls).toHaveLength(1);
    expect(dict.persisted).toHaveLength(1);
    expect(dict.persisted[0]).toMatchObject({
      form: 'saw',
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
    });
    expect(dict.persisted[0].entries.map((entry) => entry.lemma)).toEqual(['see', 'saw']);
  });

  it('answers with what the write re-read, not with what the model replied', async () => {
    // The re-read is what makes the writer's answer identical to the next
    // reader's, so the service must not shortcut it.
    const { service, dict } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          {
            lemma: 'saw',
            part_of_speech: 'noun',
            senses: [{ translation: 'מסור', sense_code: 'tool' }],
          },
        ],
      }),
    );
    dict.reread = [row('לראות'), row('מסור')];

    const result = await service.translate({ text: 'saw' });

    expect(result.senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור']);
  });

  it('merges two entries for one lemma before writing, so neither is dropped', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          {
            lemma: 'book',
            part_of_speech: 'noun',
            senses: [{ translation: 'ספר', sense_code: 'printed_book' }],
          },
          {
            lemma: 'book',
            part_of_speech: 'noun',
            senses: [{ translation: 'כרך', sense_code: 'volume' }],
          },
        ],
      }),
    );

    await service.translate({ text: 'book' });

    expect(dict.persisted[0].entries).toHaveLength(1);
    expect(dict.persisted[0].entries[0].senses).toHaveLength(2);
  });

  it('still answers 200 with the flattened entries when the write throws', async () => {
    const { service, dict, logger } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          {
            lemma: 'saw',
            part_of_speech: 'noun',
            senses: [{ translation: 'מסור', sense_code: 'tool' }],
          },
        ],
      }),
    );
    dict.persistError = new Error('deadlock detected');

    const result = await service.translate({ text: 'saw' });

    expect(result.senses).toEqual([{ translation: 'מסור', part_of_speech: 'noun' }]);
    expect(logger.errors.map((entry) => entry.message)).toContain('dict_persist_failed');
  });

  it('writes nothing for a sentence, an empty entry list, or a provider failure', async () => {
    const sentence = serviceWith(
      reply({
        kind: 'sentence',
        entries: [
          {
            lemma: 'I read a book',
            part_of_speech: 'verb',
            senses: [{ translation: 'קראתי ספר.', sense_code: 's' }],
          },
        ],
      }),
    );
    await sentence.service.translate({ text: 'I read a book' });
    expect(sentence.dict.persisted).toHaveLength(0);

    const empty = serviceWith(reply({ kind: 'word', entries: [] }));
    await empty.service.translate({ text: 'asdkjhasd' });
    expect(empty.dict.persisted).toHaveLength(0);

    const blocked = serviceWith('');
    await blocked.service.translate({ text: 'asdkjhasd' });
    expect(blocked.dict.persisted).toHaveLength(0);

    const down = serviceWith(new LlmUnavailable('responded 500'));
    await expect(down.service.translate({ text: 'saw' })).rejects.toBeInstanceOf(LlmUnavailable);
    expect(down.dict.persisted).toHaveLength(0);
  });

  it('logs what it persisted', async () => {
    const { service, logger } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          {
            lemma: 'saw',
            part_of_speech: 'noun',
            senses: [{ translation: 'מסור', sense_code: 'tool' }],
          },
        ],
      }),
    );

    await service.translate({ text: 'saw' });

    expect(logger.events).toEqual([
      { event: 'dict_persisted', entry_count: 1, lexemes_created: 1 },
      { event: 'translated', direction: 'en_he', kind: 'word', sense_count: 1 },
    ]);
  });

  // After the extraction the hit log lives in `translate` and fires for every
  // step-1 hit, repaired or not: `serveForm` logs the repair events — they
  // describe the repair whichever path reached it — and never the hit, because
  // only the caller knows whether it was a cache hit or a redirect hit. Before
  // the extraction a SUCCESSFUL repair returned without logging dict_cache_hit
  // while a FAILED one fell through and logged it, which is the inconsistency
  // this pins away.
  it('logs a cache hit whether or not the hit needed a repair', async () => {
    const { service, dict, logger } = serviceWith(
      reply({ senses: [{ sense_code: 'rung', translation: 'שלב' }] }),
    );
    dict.hit = { ladder: [row('סולם', { lexemeId: 't-1' })] };
    dict.stale = {
      ladder: [{ lexemeId: 't-1', variantId: 'v-1', lemma: 'ladder', partOfSpeech: 'noun' }],
    };
    // `repairForm` keeps only a rendering whose sense_code is already stored for
    // this lexeme (an unknown code names no sense, and a repair may not invent
    // one). Without this the model's reply above matches nothing, the repair
    // throws, and the test would exercise a FAILED repair instead of the
    // successful one this test is about.
    dict.stored['ladder:noun'] = [
      { senseCode: 'rung', translation: 'שלב-ישן', exampleSource: null, exampleTarget: null },
    ];

    await service.translate({ text: 'ladder' });

    const events = logger.events.map((event) => event.event);
    expect(events).toContain('dict_repaired');
    expect(events).toContain('dict_cache_hit');
  });
});

// Phase 12's second model call. Two independent lookups of one lexeme name the
// same sense differently — `bank` says river_bank where `banks` says river_edge
// — so matching stored senses on the code alone would duplicate the meaning
// silently. Where a lexeme already has senses, a second, smaller call reconciles
// by meaning instead.
describe('reconciliation', () => {
  const oneVerb = reply({
    kind: 'word',
    entries: [
      {
        lemma: 'cook',
        part_of_speech: 'verb',
        senses: [{ translation: 'PAST-RENAMED', sense_code: 'renamed_by_this_call' }],
      },
    ],
  });

  const storedReserve = [
    {
      senseCode: 'prepare_food',
      translation: 'INF-PREPARE',
      exampleSource: null,
      exampleTarget: null,
    },
  ];

  it('makes one client call when the lexeme is new', async () => {
    const { service, llm, dict } = serviceWith(oneVerb);

    await service.translate({ text: 'cook' });

    expect(llm.calls).toHaveLength(1);
    // It still asked — "no stored senses" is an answer, not a skipped read.
    expect(dict.lexemeReads).toEqual([{ lemma: 'cook', partOfSpeech: 'verb' }]);
  });

  it('makes a second call when the lexeme already has senses', async () => {
    const { service, llm, dict } = serviceWith(
      oneVerb,
      reply({ senses: [{ sense_code: 'prepare_food', translation: 'PAST-PREPARE' }] }),
    );
    dict.stored['cook:verb'] = storedReserve;

    const result = await service.translate({ text: 'cooked' });

    expect(llm.calls).toHaveLength(2);
    // The stored code won, not the one call 1 invented.
    expect(dict.persisted[0].entries[0].senses[0].sense_code).toBe('prepare_food');
    expect(result.senses[0].translation).toBe('PAST-PREPARE');
  });

  it('does not make a second call for a sentence', async () => {
    // The branch sits after the sentence guard: a sentence is never written to
    // the dictionary, so a database round trip and a second model call would
    // both be spent on an answer that is then discarded.
    const { service, llm, dict } = serviceWith(
      reply({
        kind: 'sentence',
        entries: [
          {
            lemma: 'I cooked dinner',
            part_of_speech: 'verb',
            senses: [{ translation: 'בישלתי ארוחת ערב.', sense_code: 'the_sentence' }],
          },
        ],
      }),
    );

    await service.translate({ text: 'I cooked dinner' });

    expect(llm.calls).toHaveLength(1);
    expect(dict.lexemeReads).toEqual([]);
  });

  it('writes nothing and propagates the error when the second call fails', async () => {
    const { service, dict } = serviceWith(oneVerb, new LlmUnavailable('network failure'));
    dict.stored['cook:verb'] = storedReserve;

    // Deliberately unlike the failed-WRITE path below, which still answers 200:
    // that one protects a correct answer whose storage failed, this one prevents
    // storing an answer known to be wrong into a dictionary with no TTL.
    await expect(service.translate({ text: 'cooked' })).rejects.toBeInstanceOf(LlmUnavailable);
    expect(dict.persisted).toHaveLength(0);
  });

  it('drops a sense the form does not admit, and re-sequences the ranks', async () => {
    const { service, dict } = serviceWith(
      oneVerb,
      reply({
        senses: [
          { sense_code: 'fabricate_accounts', translation: 'PAST-FABRICATE' },
          { sense_code: 'prepare_food', translation: null },
        ],
      }),
    );
    dict.stored['cook:verb'] = storedReserve;

    const result = await service.translate({ text: 'cooked' });

    const senses = dict.persisted[0].entries[0].senses;
    expect(senses.map((s) => s.sense_code)).toEqual(['fabricate_accounts']);
    expect(result.senses.map((s) => s.translation)).toEqual(['PAST-FABRICATE']);
  });

  it('dedupes two renderings sharing a code, keeping the first', async () => {
    // Not defensive tidying: two renderings with one sense_code resolve to one
    // sense id, so they become two rows with the same
    // (variant_id, sense_id, user_language_code) — a primary-key collision that
    // DO NOTHING swallows, leaving a hole in the rank sequence that
    // UNIQUE(variant_id, user_language_code, rank) then rejects.
    const { service, dict } = serviceWith(
      oneVerb,
      reply({
        senses: [
          { sense_code: 'prepare_food', translation: 'FIRST' },
          { sense_code: 'prepare_food', translation: 'SECOND' },
        ],
      }),
    );
    dict.stored['cook:verb'] = storedReserve;

    await service.translate({ text: 'cooked' });

    expect(dict.persisted[0].entries[0].senses).toHaveLength(1);
    expect(dict.persisted[0].entries[0].senses[0].translation).toBe('FIRST');
  });

  it('logs what was reused and what was newly named', async () => {
    const { service, dict, logger } = serviceWith(
      oneVerb,
      reply({
        senses: [
          { sense_code: 'prepare_food', translation: 'PAST-PREPARE' },
          { sense_code: 'fabricate_accounts', translation: 'PAST-FABRICATE' },
        ],
      }),
    );
    dict.stored['cook:verb'] = storedReserve;

    await service.translate({ text: 'cooked' });

    // Drift is visible from the log alone, without reading rows: a lexeme whose
    // senses keep growing is a prompt that keeps renaming them.
    expect(logger.events).toContainEqual({
      event: 'dict_reconciled',
      entry_count: 1,
      reused: 1,
      newly_named: 1,
    });
  });
});

describe('the stored redirect', () => {
  const redirect = (over: Partial<CorrectionRow> = {}): CorrectionRow => ({
    typedForm: 'thruot',
    correctedForm: 'throat',
    alternatives: ['throughout'],
    ...over,
  });

  it('answers a known typo from the corrected form, with NO provider call', async () => {
    const { service, llm, dict, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    dict.corrections = { thruot: redirect() };
    dict.hit = { throat: [row('גרון', { kind: 'word' })] };

    const result = await service.translate({ text: 'thruot' });

    expect(llm.calls).toHaveLength(0);
    expect(result.senses).toEqual([{ translation: 'גרון' }]);
    expect(result.kind).toBe('word');
    // The typed string survives in exactly two places: the response's `text`, and
    // the dict_corrections row.
    expect(result.text).toBe('thruot');
    expect(result.correction).toEqual({ corrected_form: 'throat', alternatives: ['throughout'] });
    const events = logger.events.map((event) => event.event);
    expect(events).toContain('dict_redirect_hit');
    // A redirect hit is NOT also a cache hit. The ratio between the two events is
    // precisely what the second one exists to show.
    expect(events).not.toContain('dict_cache_hit');
  });

  // Step 1 precedes step 2, permanently. A string that is a real form in its own
  // right is never routed away from itself, even if a redirect for it exists —
  // which is the same rule that makes a typo shadow its own redirect once a
  // variant is written for it.
  it('never consults a redirect for a form that has rows of its own', async () => {
    const { service, dict, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    dict.corrections = { throat: redirect({ typedForm: 'throat', correctedForm: 'throughout' }) };
    dict.hit = { throat: [row('גרון', { kind: 'word' })] };

    const result = await service.translate({ text: 'throat' });

    expect(result.correction).toBeUndefined();
    expect(result.senses).toEqual([{ translation: 'גרון' }]);
    expect(logger.events.map((event) => event.event)).toContain('dict_cache_hit');
  });

  it('falls through to the model when the redirect target has no rows', async () => {
    const { service, llm, dict } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('thruot', [{ translation: 'גרון', sense_code: 'body_part' }]),
      }),
    );
    dict.corrections = { thruot: redirect() };
    dict.hit = {};

    await service.translate({ text: 'thruot' });

    expect(llm.calls).toHaveLength(1);
  });

  // Step 3 goes through serveForm, staleness probe and repair included. Read the
  // rows directly here instead and `thruot` would serve two senses forever while
  // `throat` kept converging on three — permanently, since a redirect hit makes no
  // provider call and nothing else visits that path.
  //
  // What this asserts is that the repair RAN, not what it produced. `repairForm`
  // closes with `findSensesByForm(form)`, which in this fake reads `dict.hit`
  // again and so returns the same rows before and after — `dict.reread` feeds
  // `persistEntries`, not the repair. Proving the repair CHANGED the answer needs
  // real rows, and that is the integration bucket's job (Task 11's byte-identical
  // case).
  it('repairs a stale redirect target, with exactly one provider call', async () => {
    const { service, llm, dict } = serviceWith(
      reply({ senses: [{ sense_code: 'body_part', translation: 'צוואר' }] }),
    );
    dict.corrections = { thruot: redirect() };
    dict.hit = { throat: [row('גרון', { lexemeId: 't-1', kind: 'word' })] };
    dict.stale = {
      throat: [{ lexemeId: 't-1', variantId: 'v-1', lemma: 'throat', partOfSpeech: 'noun' }],
    };
    dict.stored['throat:noun'] = [
      { senseCode: 'body_part', translation: 'גרון', exampleSource: null, exampleTarget: null },
    ];

    const result = await service.translate({ text: 'thruot' });

    // The repair call, and only it — a redirect hit pays no call 1.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toContain('reusing its sense_code EXACTLY');
    expect(llm.calls[0].user).toBe('throat');
    expect(dict.repaired).toEqual([{ variantId: 'v-1', senseVersion: 0 }]);
    expect(result.correction).toEqual({ corrected_form: 'throat', alternatives: ['throughout'] });
  });

  // The convention every other event in this file holds to, and the one a new
  // event is most likely to break.
  it('keeps the learner\'s text out of both new events', async () => {
    const { service, dict, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    dict.corrections = { thruot: redirect() };
    dict.hit = { throat: [row('גרון', { kind: 'word' })] };

    await service.translate({ text: 'thruot' });

    const serialized = JSON.stringify(logger.events);
    expect(serialized).not.toContain('thruot');
    expect(serialized).not.toContain('throat');
  });
});

describe('a correction on the miss path', () => {
  const corrected = (over: Record<string, unknown> = {}) =>
    reply({
      kind: 'word',
      entries: [
        {
          lemma: 'book',
          part_of_speech: 'verb',
          senses: [{ translation: 'הזמין', sense_code: 'make_reservation' }],
        },
      ],
      correction: { corrected_form: 'booked', alternatives: ['booted'] },
      ...over,
    });

  // Criterion 4. The substitution happens ONCE, inside resolveCorrection, and
  // every downstream use is covered by construction.
  it('hands persistEntries the corrected form, never the typed one', async () => {
    const { service, dict } = serviceWith(corrected());

    const result = await service.translate({ text: 'bokked' });

    expect(dict.persisted).toHaveLength(1);
    expect(dict.persisted[0].form).toBe('booked');
    expect(result.text).toBe('bokked');
    expect(result.correction).toEqual({ corrected_form: 'booked', alternatives: ['booted'] });
  });

  // The reconciliation call phase 12 added never sees the typed string. Hand that
  // prompt `bokked` and it renders a misspelling, permanently.
  it('hands buildRenderingPrompt the corrected form when the lexeme already has senses', async () => {
    const { service, llm, dict } = serviceWith(
      corrected(),
      reply({ senses: [{ sense_code: 'make_reservation', translation: 'הזמין' }] }),
    );
    dict.stored['book:verb'] = [
      { senseCode: 'make_reservation', translation: 'להזמין', exampleSource: null, exampleTarget: null },
    ];

    await service.translate({ text: 'bokked' });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].user).toBe('booked');
    expect(llm.calls[1].system).toContain('"booked"');
    expect(llm.calls[1].system).not.toContain('bokked');
  });

  it('writes the redirect beside the entries, and logs dict_corrected', async () => {
    const { service, dict, logger } = serviceWith(corrected());

    await service.translate({ text: 'bokked' });

    expect(dict.correctionsWritten).toEqual([
      expect.objectContaining({
        typedForm: 'bokked',
        correctedForm: 'booked',
        alternatives: ['booted'],
      }),
    ]);
    expect(logger.events.map((event) => event.event)).toContain('dict_corrected');
    expect(JSON.stringify(logger.events)).not.toContain('bokked');
  });

  // Criterion 8's fourth guard, at the service level: the same path an unparseable
  // answer takes. Nothing is written and no second call is made — the entries
  // describe the corrected headword, so they are wrong in the same way the form is.
  it('raises TranslationUnreadable when the corrected form is in the other script', async () => {
    const { service, llm, dict } = serviceWith(
      corrected({ correction: { corrected_form: 'שלום' } }),
    );

    await expect(service.translate({ text: 'shalom' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
    expect(llm.calls).toHaveLength(1);
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(0);
  });

  // Criterion 7. Both halves: no correction block, AND a kind that did not come
  // from the corrected form.
  it('reports no correction and no derived kind for an answer with no entries', async () => {
    const { service, dict } = serviceWith(
      reply({ kind: 'phrase', entries: [], correction: { corrected_form: 'zxq wbtl' } }),
    );

    const result = await service.translate({ text: 'zxqwbtl' });

    expect(result.correction).toBeUndefined();
    expect(result.kind).toBe('word');
    expect(result.senses).toEqual([]);
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(0);
  });

  // Criterion 14, and the decision this is one `if` away from reversing. A
  // redirect exists, its target has no rows, and call 1 answers with entries and
  // NO correction. Reusing redirect.correctedForm as the effective form would look
  // like a free mitigation and is rejected: when no correction is present the model
  // has been told to build its examples around the input AS TYPED, and those
  // examples are exactly what persistEntries stores. Writing that answer under
  // `throat` would file example sentences containing `thruot` against the correctly
  // spelled form, permanently — the defect the third prompt rule exists to prevent,
  // reintroduced through the one path that bypasses the rule's precondition.
  it('answers the model on its own terms when it declines to correct', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('thruot', [{ translation: 'גרון', sense_code: 'body_part' }]),
      }),
    );
    dict.corrections = {
      thruot: { typedForm: 'thruot', correctedForm: 'throat', alternatives: [] },
    };
    dict.hit = {};

    const result = await service.translate({ text: 'thruot' });

    expect(dict.persisted[0].form).toBe('thruot');
    expect(result.correction).toBeUndefined();
  });

  // Criterion 5, unit half. `reconcile` is called ABOVE the
  // `try { transaction(...) }` block, so a failing call never reaches an open
  // transaction — what this proves is fail-closed: a failed reconciliation
  // reaches neither write. It would pass exactly the same with steps 8 and 9
  // in two transactions, or ten. The shared transaction itself is established
  // BY CONSTRUCTION at services/translations.ts, in the
  // `transaction(async (repos) => { ... })` callback that contains both
  // writes, not by this test — steps 8 and 9 are DEPENDENT there: a redirect
  // must not point at a form with no rows.
  it('writes neither entries nor a redirect when the reconciliation call fails', async () => {
    const { service, dict } = serviceWith(corrected(), 'not json at all');
    dict.stored['book:verb'] = [
      { senseCode: 'make_reservation', translation: 'להזמין', exampleSource: null, exampleTarget: null },
    ];

    await expect(service.translate({ text: 'bokked' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(0);
  });

  // A sentence carrying a correction is answered SILENTLY: the notice is
  // suppressed and the entries kept. A judgement, not an oversight — a sentence is
  // never written to the dictionary so nothing is poisoned, and refusing the answer
  // would fail a request the model translated correctly over a field it was told
  // not to send.
  it('suppresses the notice on a sentence but keeps the translation', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'sentence',
        ...oneEntry('I have a sore throat', [{ translation: 'יש לי כאב גרון.', sense_code: 's' }], 'verb'),
        correction: { corrected_form: 'I have a sore throat' },
      }),
    );

    const result = await service.translate({ text: 'I have a sore thruot' });

    expect(result.kind).toBe('sentence');
    expect(result.senses).toEqual([{ translation: 'יש לי כאב גרון.' }]);
    expect(result.correction).toBeUndefined();
    expect(dict.persisted).toHaveLength(0);
  });
});

describe('the corrected-form probe', () => {
  const correctingReply = reply({
    kind: 'word',
    entries: [
      // Deliberately ADJECTIVE FIRST, where the stored `booked` below has the verb
      // at entry_rank 0. That is the shape that made the un-probed flow collide on
      // dict_variants_form_entry_rank_key, answer 200 from the catch, and roll the
      // redirect back with the write — forever.
      { lemma: 'book', part_of_speech: 'adjective', senses: [{ translation: 'מוזמן', sense_code: 'reserved' }] },
      { lemma: 'book', part_of_speech: 'verb', senses: [{ translation: 'הזמין', sense_code: 'make_reservation' }] },
    ],
    correction: { corrected_form: 'booked', alternatives: [] },
  });

  // Criterion 23, and the ordinary corrected miss once the backfill lands.
  it('serves a target the dictionary already holds, with one call and no write to it', async () => {
    const { service, llm, dict, logger } = serviceWith(correctingReply);
    dict.hit = { booked: [row('הזמין', { kind: 'word', lexemeId: 't-verb' })] };

    const result = await service.translate({ text: 'bokked' });

    expect(llm.calls).toHaveLength(1);
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toEqual([
      expect.objectContaining({ typedForm: 'bokked', correctedForm: 'booked' }),
    ]);
    // The target's stored answer, unchanged, plus the correction block.
    expect(result.kind).toBe('word');
    expect(result.senses).toEqual([{ translation: 'הזמין' }]);
    expect(result.correction).toEqual({ corrected_form: 'booked', alternatives: [] });
    expect(logger.events.map((event) => event.event)).toContain('dict_corrected');
  });

  // The R8 amendment's "independent" claim, as a test: two writes, in this order.
  it('repairs a stale target inside serveForm and still writes the redirect after', async () => {
    const { service, llm, dict } = serviceWith(
      correctingReply,
      reply({ senses: [{ sense_code: 'make_reservation', translation: 'הזמין' }] }),
    );
    dict.hit = { booked: [row('להזמין', { kind: 'word', lexemeId: 't-verb' })] };
    dict.stale = {
      booked: [{ lexemeId: 't-verb', variantId: 'v-booked', lemma: 'book', partOfSpeech: 'verb' }],
    };
    // Without a known sense_code to match against, repairForm has nothing to
    // repair TO — "an unknown code names no stored sense, and a repair may not
    // invent one" — so it would throw, get swallowed by serveForm's catch, and
    // this test would exercise a FAILED repair instead of the successful one it
    // is about. Same fixture the redirect-repair test above and the cache-hit
    // repair test use, for the same reason.
    dict.stored['book:verb'] = [
      { senseCode: 'make_reservation', translation: 'להזמין', exampleSource: null, exampleTarget: null },
    ];

    const result = await service.translate({ text: 'bokked' });

    // Call 1 and the repair. NOT a reconciliation for the miss pipeline — that
    // pipeline never runs.
    expect(llm.calls).toHaveLength(2);
    expect(dict.repaired).toHaveLength(1);
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(1);
    expect(result.correction).toEqual({ corrected_form: 'booked', alternatives: [] });
  });

  // The case the third revision traced, and the only one in which the
  // reconciliation path is handed the corrected form.
  it('falls through to the pipeline when the corrected form has no rows of its own', async () => {
    const { service, dict } = serviceWith(correctingReply);
    dict.hit = {};

    await service.translate({ text: 'bokked' });

    expect(dict.persisted).toHaveLength(1);
    expect(dict.persisted[0].form).toBe('booked');
    expect(dict.correctionsWritten).toHaveLength(1);
  });

  // Criterion 24. The model's entries described `throte`; they are discarded
  // unwritten, and the redirect points straight at `throat`.
  it('follows a corrected form that is itself a known typo, one hop', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('throte', [{ translation: 'גרון', sense_code: 'body_part' }]),
        correction: { corrected_form: 'throte', alternatives: [] },
      }),
    );
    dict.corrections = {
      throte: { typedForm: 'throte', correctedForm: 'throat', alternatives: ['throaty'] },
    };
    dict.hit = { throat: [row('גרון', { kind: 'word' })] };

    const result = await service.translate({ text: 'thruot' });

    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toEqual([
      expect.objectContaining({ typedForm: 'thruot', correctedForm: 'throat' }),
    ]);
    // The correction block names the HOP's target, and carries the hop's own
    // alternatives — the model's described `throte`, which nothing is written for.
    expect(result.correction).toEqual({ corrected_form: 'throat', alternatives: ['throaty'] });
    expect(result.senses).toEqual([{ translation: 'גרון' }]);
  });

  // One hop, no further. A chain AND a truncated dictionary: accepted, and it
  // fails the lookup rather than reading on, so the number of reads never depends
  // on data.
  it('fails the lookup and writes nothing when the hop target has no rows either', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('throte', [{ translation: 'גרון', sense_code: 'body_part' }]),
        correction: { corrected_form: 'throte', alternatives: [] },
      }),
    );
    dict.corrections = {
      throte: { typedForm: 'throte', correctedForm: 'throat', alternatives: [] },
    };
    dict.hit = {};

    await expect(service.translate({ text: 'thruot' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(0);
  });

  // The probe runs ONLY when a correction is present. An uncorrected miss must
  // pay no extra read.
  it('does not probe when the model reported no correction', async () => {
    const { service, dict } = serviceWith(
      reply({ kind: 'word', ...oneEntry('kite', [{ translation: 'עפיפון', sense_code: 'toy' }]) }),
    );

    await service.translate({ text: 'kite' });

    expect(dict.persisted[0].form).toBe('kite');
    expect(dict.correctionsWritten).toHaveLength(0);
    // The count that actually discriminates "no probe": step 1's serveForm is the
    // only read here. If the `if (correction)` guard at step 5b were ever dropped
    // or widened, its serveForm would push a second findSensesByForm read, and
    // this would catch it even though the outcome above stays the same either way.
    expect(dict.reads).toHaveLength(1);
  });
});
