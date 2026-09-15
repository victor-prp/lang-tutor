import { describe, expect, it } from '@jest/globals';

import {
  buildPrompt,
  buildRenderingPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmReconciliation,
  parseLlmTranslation,
  resolveCorrection,
  resolveKind,
  tidyAlternatives,
} from './translation';

describe('detectDirection', () => {
  it('reads Latin script as English to Hebrew', () => {
    expect(detectDirection('book')).toBe('en_he');
    expect(detectDirection('break a leg')).toBe('en_he');
  });

  it('reads any Hebrew character as Hebrew to English', () => {
    expect(detectDirection('מזלג')).toBe('he_en');
    expect(detectDirection('ספר')).toBe('he_en');
  });

  it('treats mixed input as Hebrew, because one Hebrew letter settles it', () => {
    expect(detectDirection('the ספר')).toBe('he_en');
  });

  it('falls back to en_he for input with no letters at all', () => {
    expect(detectDirection('123')).toBe('en_he');
  });
});

describe('resolveKind', () => {
  it('forces word for a single token, whatever the model said', () => {
    expect(resolveKind('book', 'sentence')).toBe('word');
    expect(resolveKind('  book  ', 'phrase')).toBe('word');
  });

  it('trusts the model once there is internal whitespace', () => {
    expect(resolveKind('break a leg', 'phrase')).toBe('phrase');
    expect(resolveKind('I read a book', 'sentence')).toBe('sentence');
  });
});

describe('buildPrompt', () => {
  it('puts only the learner text in the user part', () => {
    expect(buildPrompt({ text: 'book', direction: 'en_he' }).user).toBe('book');
  });

  it('states the direction in the system part', () => {
    expect(buildPrompt({ text: 'book', direction: 'en_he' }).system).toContain('English');
    expect(buildPrompt({ text: 'ספר', direction: 'he_en' }).system).toContain('Hebrew');
  });

  it('carries the three rules that exist because of specific failures', () => {
    const { system } = buildPrompt({ text: 'break a leg', direction: 'en_he' });
    expect(system).toMatch(/imperative/i); // fixed expressions stay phrases
    expect(system).toMatch(/idiom/i); // translated by meaning, not word by word
    expect(system).toMatch(/exactly one sense/i); // a sentence is not polysemous
  });

  it('caps senses and forbids inventing a translation', () => {
    const { system } = buildPrompt({ text: 'asdkjhasd', direction: 'en_he' });
    expect(system).toMatch(/at most 5/i);
    expect(system).toMatch(/empty/i);
  });

  it('hands over the Zod schema itself, not a JSON Schema document', () => {
    const { schema } = buildPrompt({ text: 'book', direction: 'en_he' });
    expect(typeof schema.safeParse).toBe('function');
  });

  it('asks for entries, one per headword, ranked', () => {
    const { system } = buildPrompt({ text: 'saw', direction: 'en_he' });
    expect(system).toMatch(/entry per headword/i);
    expect(system).toMatch(/at most 6/i);
  });

  // Phase 12 inverted this. `book` is still the worked example, but it is now
  // the example of a lemma that is TWO entries rather than one — the shape
  // phase 10 asked for is what made an inflected verb form serve noun senses.
  it('gives book as the worked example of two entries, not of one', () => {
    const { system } = buildPrompt({ text: 'book', direction: 'en_he' });
    expect(system).toContain('"book" is two entries, one noun and one verb');
    expect(system).toContain('"booked" is the verb entry only, never the noun');
  });

  it('asks for a sense_code on every sense', () => {
    expect(buildPrompt({ text: 'bank', direction: 'en_he' }).system).toMatch(/sense_code/);
  });

  it('says senses belong to the headword, not to the typed form', () => {
    expect(buildPrompt({ text: 'running', direction: 'en_he' }).system).toMatch(/inflected/i);
  });

  // Asserted as a NEGATIVE on the old wording, because the failure this prevents
  // is the old rule surviving BESIDE the new one — and an addition looks
  // identical to a replacement in every test that only checks the new text is
  // present.
  it('replaces the unconditional not-a-word rule rather than supplementing it', () => {
    const { system } = buildPrompt({ text: 'thruot', direction: 'en_he' });
    expect(system).not.toContain(
      'not a word or expression in either language, return an empty entries',
    );
    expect(system).toContain('no real word or expression was plausibly intended');
  });

  it('tells the model a correctly spelled inflected form is not a misspelling', () => {
    const { system } = buildPrompt({ text: 'booked', direction: 'en_he' });
    expect(system).toMatch(/inflected form is not a misspelling/i);
    expect(system).toContain('walks');
    expect(system).toContain('went');
  });

  it('asks for a surface form and up to three ranked alternatives', () => {
    const { system } = buildPrompt({ text: 'bokked', direction: 'en_he' });
    expect(system).toContain('correction.corrected_form');
    expect(system).toMatch(/surface form/i);
    // The distinction the whole feature turns on: `bokked` wants `booked`, whose
    // lemma is `book` — and phase 12 made that difference load-bearing, because
    // `booked` renders הזמין where `book` renders להזמין.
    expect(system).toContain('`bokked` corrects to `booked`');
    expect(system).toContain('correction.alternatives');
  });

  it('suspends the build-the-example-around-the-input rule when a correction is present', () => {
    const { system } = buildPrompt({ text: 'bokked', direction: 'en_he' });
    expect(system).toMatch(/build the example sentence around `?corrected_form`?/i);
  });

  // The fourth rule, and the one a reader will think redundant. `resolveKind`
  // clamps a single token to `word` and otherwise DEFERS to the model, so it
  // cannot rule on a multi-token corrected form; `kind` is then written onto
  // dict_variants.kind for that form, first-writer-wins, and read back by
  // `kindForForm` on every later hit — including the hit a learner who spells
  // `break a leg` correctly gets. Without this rule one mistyped lookup freezes
  // `kind: 'word'` on a real phrase for the life of the dictionary.
  it('tells the model to classify the corrected form, not the input as typed', () => {
    const { system } = buildPrompt({ text: 'breakaleg', direction: 'en_he' });
    expect(system).toMatch(/classify `?corrected_form`? rather than the input as typed/i);
    expect(system).toContain('breakaleg');
  });

  // The wording lock that keeps an illustration word from silently capturing the
  // integration bucket's MockServer expectations. The system instruction is part
  // of the request body those expectations match a regex against, so naming
  // `saws` here would make EVERY first call in that bucket match the `saw`
  // expectation and be answered with the wrong payload — a failure that looks
  // like a service bug and is a prompt edit. Phase 12 hit exactly this.
  //
  // Deliberately NOT asserted for the quoted expectations (`"bank"`, `"scan"`,
  // `"saw"`). The body is JSON.stringify'd, so a quoted word in the instruction
  // arrives as \"bank\" and the expectation's regex `"bank"` does not match it:
  // the closing quote is preceded by a backslash. What a quoted expectation
  // matches is the user part, "text":"bank". Forbidding those here would lock a
  // non-rule.
  //
  // RE-DERIVE THIS LIST from the registered `matchText` values before changing
  // any illustration word in any rule. It grows every time a test registers an
  // UNQUOTED matchText.
  it('names neither saw nor see, the two unquoted MockServer expectations', () => {
    for (const text of ['book', 'ספר', 'break a leg']) {
      for (const direction of ['en_he', 'he_en'] as const) {
        const { system } = buildPrompt({ text, direction });
        expect(system).not.toContain('saw');
        expect(system).not.toContain('see');
      }
    }
  });
});

describe('parseLlmTranslation', () => {
  const sense = { translation: 'ספר', sense_code: 'printed_book' };

  it('parses a well-formed response', () => {
    const entry = { lemma: 'book', part_of_speech: 'noun', senses: [sense] };
    const raw = JSON.stringify({ kind: 'word', entries: [entry] });
    expect(parseLlmTranslation(raw)).toEqual({ kind: 'word', entries: [entry] });
  });

  it('parses a two-entry payload — the answer the entries model exists for', () => {
    const raw = JSON.stringify({
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
    });
    expect(parseLlmTranslation(raw)?.entries).toHaveLength(2);
  });

  it('treats null and absent identically, so an OpenAI-style response still parses', () => {
    const raw = JSON.stringify({
      kind: 'sentence',
      entries: [
        {
          lemma: 'I read a book',
          part_of_speech: 'verb',
          senses: [
            {
              translation: 'קראתי ספר.',
              part_of_speech: null,
              example: null,
              sense_code: 'the_sentence',
            },
          ],
        },
      ],
    });
    const parsed = parseLlmTranslation(raw);
    expect(parsed?.entries[0].senses[0]).not.toHaveProperty('part_of_speech');
  });

  it('treats an empty entry list as the empty answer rather than as unreadable', () => {
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', entries: [] }))).toEqual({
      kind: 'word',
      entries: [],
    });
  });

  it('returns null for output that is not JSON', () => {
    expect(parseLlmTranslation('I cannot help with that.')).toBeNull();
    expect(parseLlmTranslation('')).toBeNull();
  });

  it('returns null for JSON of the wrong shape', () => {
    expect(parseLlmTranslation(JSON.stringify({ entries: [] }))).toBeNull();
    expect(parseLlmTranslation(JSON.stringify({ kind: 'clause', entries: [] }))).toBeNull();
    // The phase 9 shape is now the wrong shape.
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', senses: [sense] }))).toBeNull();
  });

  it('returns null for an entry missing its lemma, or holding no senses', () => {
    expect(
      parseLlmTranslation(JSON.stringify({ kind: 'word', entries: [{ senses: [sense] }] })),
    ).toBeNull();
    expect(
      parseLlmTranslation(JSON.stringify({ kind: 'word', entries: [{ lemma: 'book', senses: [] }] })),
    ).toBeNull();
  });

  it('returns null when a sense carries no sense_code', () => {
    const raw = JSON.stringify({
      kind: 'word',
      entries: [{ lemma: 'book', senses: [{ translation: 'ספר' }] }],
    });
    expect(parseLlmTranslation(raw)).toBeNull();
  });

  it('returns null when the model exceeds the caps', () => {
    const many = Array(6).fill(sense);
    expect(
      parseLlmTranslation(JSON.stringify({ kind: 'word', entries: [{ lemma: 'x', senses: many }] })),
    ).toBeNull();
    const entries = Array(4).fill({ lemma: 'x', senses: [sense] });
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', entries }))).toBeNull();
  });

  it('accepts a fenced code block, which models emit even when told not to', () => {
    const raw =
      '```json\n{"kind":"word","entries":[{"lemma":"book","part_of_speech":"noun",' +
      '"senses":[{"translation":"ספר","sense_code":"printed_book"}]}]}\n```';
    expect(parseLlmTranslation(raw)?.entries[0].lemma).toBe('book');
  });
});

describe('normalizeSenses', () => {
  it('reduces a sentence to one sense with no part of speech and no example', () => {
    const senses = [
      {
        translation: 'קראתי ספר על החלל.',
        part_of_speech: 'verb',
        example: { source: 'x', target: 'y' },
      },
      { translation: 'משהו אחר' },
    ];
    expect(normalizeSenses('sentence', senses)).toEqual([{ translation: 'קראתי ספר על החלל.' }]);
  });

  it('leaves a word and a phrase untouched', () => {
    const senses = [{ translation: 'ספר', part_of_speech: 'noun' }];
    expect(normalizeSenses('word', senses)).toEqual(senses);
    expect(normalizeSenses('phrase', senses)).toEqual(senses);
  });

  it('handles an empty list', () => {
    expect(normalizeSenses('sentence', [])).toEqual([]);
  });
});

// Phase 12: one entry per (headword, part of speech), and a translation that
// agrees grammatically with the form that was typed.
describe('buildPrompt, phase 12', () => {
  it('asks for one entry per lemma and part of speech, with form agreement', () => {
    const { system } = buildPrompt({ text: 'booked', direction: 'en_he' });
    expect(system).toMatch(/one entry per headword AND part of speech/i);
    expect(system).toMatch(/grammatical form matching the input/i);
    expect(system).toMatch(/third-person masculine singular/i);
    expect(system).not.toMatch(/ONE entry per headword:/);
    expect(system).not.toMatch(/at most 3\./);
  });
});

describe('buildRenderingPrompt', () => {
  it('lists every stored sense with its gloss, and asks for null where inadmissible', () => {
    const { system, user } = buildRenderingPrompt({
      form: 'booked',
      direction: 'en_he',
      lemma: 'book',
      partOfSpeech: 'verb',
      storedSenses: [
        {
          senseCode: 'reserve',
          translation: 'INF-RESERVE',
          exampleSource: 'book a table',
          exampleTarget: 'T',
        },
      ],
    });
    expect(system).toMatch(/reserve/);
    expect(system).toMatch(/INF-RESERVE/);
    expect(system).toMatch(/null/);
    expect(user).toBe('booked');
  });

  it('names the queried form, the headword and its part of speech', () => {
    const { system } = buildRenderingPrompt({
      form: 'booked',
      direction: 'en_he',
      lemma: 'book',
      partOfSpeech: 'verb',
      storedSenses: [
        { senseCode: 'reserve', translation: 'X', exampleSource: null, exampleTarget: null },
      ],
    });
    expect(system).toContain('"book" (verb)');
    expect(system).toContain('"booked"');
    // The same form-agreement rule as the first call, or the second call would
    // undo what the first one got right.
    expect(system).toMatch(/third-person masculine singular/);
  });

  // Phase 12 follow-up. The escape hatch that lets the model name a reading the stored
  // list lacks used to be scoped to the FORM — "a reading the list above does
  // not contain" — while the row it produces is scoped to the LEXEME. Those two
  // scopes differ exactly when a form spans several lexemes, which is the normal
  // case: `pressing` is the verb `press` and the adjective `pressing`, and the
  // verb's rendering claimed the adjective's meaning. A wording lock rather than
  // a behaviour test — what the model actually does with it is scored by the
  // rendering cases in the eval bucket, which ADR 0004 R4 forbids naming by
  // path from src/ (its grep is a plain substring match, and a comment counts).
  it('confines a newly named reading to the lexeme being rendered, not the form', () => {
    const { system } = buildRenderingPrompt({
      form: 'pressing',
      direction: 'en_he',
      lemma: 'press',
      partOfSpeech: 'verb',
      storedSenses: [
        { senseCode: 'applied_force', translation: 'ללחוץ', exampleSource: null, exampleTarget: null },
      ],
    });
    // The new code is licensed by the lexeme, not by the form.
    expect(system).toContain('only for a reading that is itself "press" used as a verb');
    // And the other lexemes of the same form are named as out of scope.
    expect(system).toContain('"pressing" may also belong to other headwords');
    expect(system).toMatch(/never bring their\s+readings in here/);
  });

  it('asks for the stored code back unchanged, which is the whole point', () => {
    const { system } = buildRenderingPrompt({
      form: 'banks',
      direction: 'en_he',
      lemma: 'bank',
      partOfSpeech: 'noun',
      storedSenses: [
        { senseCode: 'river_bank', translation: 'גדה', exampleSource: null, exampleTarget: null },
      ],
    });
    expect(system).toMatch(/reusing its sense_code EXACTLY/);
  });
});

describe('the participial-adjective lemma rule', () => {
  // Phase 12 follow-up, F2. Without it the model wavered — `burnt` naming the adjective
  // `burnt` and `burned` naming `burn` in the same afternoon — which put two
  // lexemes in the dictionary for one adjective, each with its own sense list
  // and neither ever able to see the other's. A wording lock; the eval bucket's
  // `burnt` and `burned` cases score what the model does with it.
  it('pins a participial adjective to the regular -ed spelling of the participle', () => {
    const { system } = buildPrompt({ text: 'burnt', direction: 'en_he' });
    expect(system).toContain('A participial adjective is its own headword rather than the base verb');
    expect(system).toContain('spelled the regular way');
    // `burning` must NOT merge: an active participle is a different adjective
    // from a passive one, which is why pinning to the base verb was rejected.
    expect(system).toContain('"burning" is the separate adjective "burning"');
  });
});

describe('the example-disambiguation rule', () => {
  // Phase 12 follow-up. Two senses of one entry can render to the same word — Hebrew says
  // מים for water-the-substance and water-the-lake — and the example is then the
  // only thing that tells the two cards apart. The recorded seed carried "The
  // water was cold.", which fits a glass and a lake equally. Measured over six
  // words before and after, the rule left the eval suite at 98.2% and stopped
  // `water` producing the ambiguous pair in 8 sampled answers.
  //
  // A wording lock on both prompts, not a behaviour test: whether an example
  // actually disambiguates is a judgement, scored by the `water` case in the
  // eval bucket.
  it('buildPrompt asks for an example that rules out the word\'s other senses', () => {
    const { system } = buildPrompt({ text: 'water', direction: 'en_he' });
    expect(system).toContain('could not be read as any other sense of the same word');
    // The illustration uses a headword that is in neither the seed nor the eval
    // set, so it cannot bias anything this repo measures.
    expect(system).toContain('spring');
  });

  it('buildRenderingPrompt asks for the same thing, since it writes examples too', () => {
    const { system } = buildRenderingPrompt({
      form: 'waters',
      direction: 'en_he',
      lemma: 'water',
      partOfSpeech: 'noun',
      storedSenses: [
        { senseCode: 'liquid_h2o', translation: 'מים', exampleSource: null, exampleTarget: null },
      ],
    });
    expect(system).toContain('could not be read as any other sense of the same word');
  });
});

describe('parseLlmReconciliation', () => {
  it('keeps a null translation through the parse', () => {
    const parsed = parseLlmReconciliation(
      '{"senses":[{"sense_code":"reserve","translation":null}]}',
    );
    expect(parsed?.senses[0].translation).toBeNull();
  });

  it('parses a rendering with an example', () => {
    const parsed = parseLlmReconciliation(
      JSON.stringify({
        senses: [
          {
            sense_code: 'reserve',
            translation: 'הזמין',
            example: { source: 'I booked a table.', target: 'הזמנתי שולחן.' },
          },
        ],
      }),
    );
    expect(parsed?.senses[0].example?.source).toBe('I booked a table.');
  });

  it('returns null for output that is not JSON, or is the wrong shape', () => {
    expect(parseLlmReconciliation('I cannot help with that.')).toBeNull();
    expect(parseLlmReconciliation('{"entries":[]}')).toBeNull();
  });
});

// A recording of `book` came back as סֵפֶר the first time phase 12's
// form-agreement rule shipped: "dictionary citation form" reads as "how a
// printed dictionary sets it", and those print nikud. Every consumer here
// matches on unvocalised text, so both prompts say the script rule outright.
describe('both prompts forbid nikud', () => {
  it('buildPrompt asks for unvocalised Hebrew', () => {
    expect(buildPrompt({ text: 'book', direction: 'en_he' }).system).toMatch(/no nikud/);
  });

  it('buildRenderingPrompt asks for unvocalised Hebrew', () => {
    const { system } = buildRenderingPrompt({
      form: 'booked',
      direction: 'en_he',
      lemma: 'book',
      partOfSpeech: 'verb',
      storedSenses: [
        { senseCode: 'reserve', translation: 'X', exampleSource: null, exampleTarget: null },
      ],
    });
    expect(system).toMatch(/no nikud/);
  });
});

describe('parseLlmTranslation and an absent or null alternatives list', () => {
  const entry = {
    lemma: 'throat',
    part_of_speech: 'noun',
    senses: [{ translation: 'גרון', sense_code: 'body_part' }],
  };

  // A provider that simply omits the empty array. A bare (required) array would
  // fail the WHOLE parse here, and one decorative empty list would turn a correct
  // translation into a 502 by way of TranslationUnreadable.
  it('parses a correction whose alternatives key is absent', () => {
    const parsed = parseLlmTranslation(
      JSON.stringify({ kind: 'word', entries: [entry], correction: { corrected_form: 'throat' } }),
    );
    expect(parsed?.correction?.corrected_form).toBe('throat');
    // undefined, not []. The schema is `.optional()`; it is `tidyAlternatives` in
    // domain/ that produces the empty array — asserted there, not here.
    expect(parsed?.correction?.alternatives).toBeUndefined();
  });

  // How structured output spells "none". `dropNulls` runs BEFORE safeParse, so
  // the key is deleted — which is fatal for a field that is neither optional nor
  // defaulted. Asserted on raw JSON, never on a pre-built object, because
  // dropNulls is the thing under test.
  it('parses a correction whose alternatives key is null', () => {
    const parsed = parseLlmTranslation(
      `{"kind":"word","entries":[${JSON.stringify(entry)}],` +
        `"correction":{"corrected_form":"throat","alternatives":null}}`,
    );
    expect(parsed?.correction?.corrected_form).toBe('throat');
    expect(parsed?.correction?.alternatives).toBeUndefined();
  });
});

describe('tidyAlternatives', () => {
  const ctx = { correctedForm: 'throat', typedForm: 'thruot' };

  it('turns an absent list into an empty one, which is what the wire schema requires', () => {
    expect(tidyAlternatives(undefined, ctx)).toEqual([]);
  });

  it('normalizes each entry the same way the corrected form is normalized', () => {
    expect(tidyAlternatives(['  Throughout.  ', 'thro   at'], ctx)).toEqual([
      'Throughout',
      'thro at',
    ]);
  });

  it('drops an entry with no letter or digit', () => {
    expect(tidyAlternatives(['???', '   ', 'throughout'], ctx)).toEqual(['throughout']);
  });

  it('removes duplicates of the corrected form, of the typed form, and of one another', () => {
    expect(
      tidyAlternatives(['Throat', 'THRUOT', 'throughout', 'Throughout'], ctx),
    ).toEqual(['throughout']);
  });

  it('truncates to three, keeping the model\'s ranking', () => {
    expect(tidyAlternatives(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'], ctx)).toEqual([
      'a1',
      'b2',
      'c3',
    ]);
  });

  // Idempotent by construction, which is what lets persistCorrection apply it a
  // second time on the way into the database without the two callers being able
  // to disagree.
  it('leaves an already-tidy list unchanged', () => {
    const tidy = tidyAlternatives(['throughout', 'throaty'], ctx);
    expect(tidyAlternatives(tidy, ctx)).toEqual(tidy);
  });
});

describe('resolveCorrection', () => {
  const entry = {
    lemma: 'throat',
    part_of_speech: 'noun' as const,
    senses: [{ translation: 'גרון', sense_code: 'body_part' }],
  };
  const answer = (over: Record<string, unknown> = {}) => ({
    kind: 'word' as const,
    entries: [entry],
    ...over,
  });
  const en = { typedForm: 'thruot', direction: 'en_he' as const };

  it('leaves an uncorrected answer on the typed form', () => {
    const resolved = resolveCorrection(answer(), en);
    expect(resolved).toEqual({ effectiveForm: 'thruot', kind: 'word' });
  });

  it('substitutes the corrected form and carries the tidied alternatives', () => {
    const resolved = resolveCorrection(
      answer({ correction: { corrected_form: 'throat', alternatives: ['throughout'] } }),
      en,
    );
    expect(resolved).toEqual({
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
      effectiveForm: 'throat',
      kind: 'word',
    });
  });

  // Guard 1. Removes a whole class of "did you mean throat? — showing results
  // for throat".
  it('drops a corrected form that normalizes to the typed form, case-insensitively', () => {
    const resolved = resolveCorrection(
      answer({ correction: { corrected_form: '  Thruot.  ' } }),
      en,
    );
    expect(resolved).toEqual({ effectiveForm: 'thruot', kind: 'word' });
  });

  // Guard 2, written as a content test rather than as "normalizes to the empty
  // string" — which is what an earlier revision specified and which does not do
  // the job. normalizeForm returns the input UNCHANGED whenever stripping would
  // empty it (`stripped === '' ? collapsed : stripped`), so normalizeForm('???')
  // is '???': it would clear an empty-string test, clear guard 1, become the
  // effective form, and be written as a dict_variants.form and as a redirect
  // target. Only a whitespace-only string normalizes to '' at all.
  it('drops a corrected form with no letter or digit, ??? included', () => {
    for (const corrected of ['???', '  ', '...']) {
      expect(resolveCorrection(answer({ correction: { corrected_form: corrected } }), en))
        .toEqual({ effectiveForm: 'thruot', kind: 'word' });
    }
  });

  // Guard 3. Detection is scoped to words and phrases, so a sentence carrying a
  // correction is the model ignoring its instructions rather than a case to
  // handle. The ENTRIES are kept — a sentence is never written to the dictionary,
  // so nothing is poisoned, and refusing the answer outright would fail a request
  // the model translated correctly over a field it was told not to send.
  it('drops a correction on a sentence but keeps the answer', () => {
    const resolved = resolveCorrection(
      answer({ kind: 'sentence', correction: { corrected_form: 'I have a sore throat' } }),
      { typedForm: 'I have a sore thruot', direction: 'en_he' },
    );
    expect(resolved).toEqual({ effectiveForm: 'I have a sore thruot', kind: 'sentence' });
  });

  // Guard 4, and the only one that is not a drop. The case is a transliteration —
  // `shalom` typed under en_he, which is not an English word and is plausibly the
  // Hebrew one, and the prompt's "either language" wording is what licenses the
  // model to name it. Dropping would not help: the entries describe the corrected
  // headword, so they are wrong in the same way. Left unchecked, `effectiveForm`
  // would be a Hebrew string written as an English variant, the redirect stored
  // under `en`, and the entries the product of an English-to-Hebrew prompt asked
  // about a Hebrew headword. A wrong row is permanent; a failed request costs one
  // retry.
  it('returns null when the corrected form is in the other script', () => {
    expect(
      resolveCorrection(answer({ correction: { corrected_form: 'שלום' } }), {
        typedForm: 'shalom',
        direction: 'en_he',
      }),
    ).toBeNull();
    expect(
      resolveCorrection(answer({ correction: { corrected_form: 'hello' } }), {
        typedForm: 'הלו',
        direction: 'he_en',
      }),
    ).toBeNull();
  });

  it('truncates a fourth alternative rather than rejecting the answer', () => {
    const resolved = resolveCorrection(
      answer({
        correction: { corrected_form: 'throat', alternatives: ['a1', 'b2', 'c3', 'd4'] },
      }),
      en,
    );
    expect(resolved?.correction?.alternatives).toEqual(['a1', 'b2', 'c3']);
  });

  it('collapses two identical alternatives to one', () => {
    const resolved = resolveCorrection(
      answer({ correction: { corrected_form: 'throat', alternatives: ['Throughout', 'throughout'] } }),
      en,
    );
    expect(resolved?.correction?.alternatives).toEqual(['Throughout']);
  });

  // THE ORDERING TRAP, and the assertion an implementation is most likely to
  // miss. Two things must be true of this answer, not one: it carries no
  // correction, AND its kind was not derived from the corrected form. Clearing at
  // the return instead of before the effective form passes the first and fails
  // the second.
  it('clears a correction on empty entries BEFORE the effective form is computed', () => {
    const resolved = resolveCorrection(
      { kind: 'phrase', entries: [], correction: { corrected_form: 'zxq wbtl' } },
      { typedForm: 'zxqwbtl', direction: 'en_he' },
    );
    expect(resolved?.correction).toBeUndefined();
    expect(resolved?.effectiveForm).toBe('zxqwbtl');
    expect(resolved?.kind).toBe('word');
  });

  it('normalizes the corrected form, so no .-suffixed key can reach the dictionary', () => {
    const resolved = resolveCorrection(
      answer({ correction: { corrected_form: 'Throat.', alternatives: ['Throughout!'] } }),
      en,
    );
    expect(resolved?.effectiveForm).toBe('Throat');
    expect(resolved?.correction?.corrected_form).toBe('Throat');
    expect(resolved?.correction?.alternatives).toEqual(['Throughout']);
  });

  // One fact read from both sides. The first half is the clamp firing on a
  // single-token corrected form — the half resolveKind handles. The second is
  // deliberately the uncomfortable one: it pins that the server CANNOT fix a
  // multi-token corrected form and that the fourth prompt rule is load-bearing.
  // An earlier revision asserted the opposite and would have passed only by
  // accident of the stub.
  it('runs resolveKind against the corrected form, clamping one token and deferring otherwise', () => {
    expect(
      resolveCorrection(answer({ kind: 'phrase', correction: { corrected_form: 'booked' } }), {
        typedForm: 'bokked',
        direction: 'en_he',
      })?.kind,
    ).toBe('word');

    expect(
      resolveCorrection(answer({ kind: 'word', correction: { corrected_form: 'break a leg' } }), {
        typedForm: 'breakaleg',
        direction: 'en_he',
      })?.kind,
    ).toBe('word');
  });
});
