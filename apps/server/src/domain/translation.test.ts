import { describe, expect, it } from '@jest/globals';

import {
  buildPrompt,
  buildRenderingPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmReconciliation,
  parseLlmTranslation,
  resolveKind,
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
