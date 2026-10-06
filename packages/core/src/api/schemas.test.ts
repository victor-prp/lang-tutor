import { describe, expect, it } from '@jest/globals';

import {
  CreateEnrollmentRequestSchema,
  CreateSessionRequestSchema,
  CreateUserRequestSchema,
  LlmCorrectionSchema,
  LlmEntrySchema,
  LlmSenseSchema,
  LlmTranslationSchema,
  PartOfSpeechSchema,
  LoginRequestSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
  SaveVocabularyRequestSchema,
  TranslationCorrectionSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
  TranslationSenseSchema,
  UserSchema,
  UsernameSchema,
  VocabularyPageQuerySchema,
  VocabularyPageSchema,
} from './schemas';
import type {
  MissedQuestion,
  NextStepResponse,
  Position,
  Question,
  Score,
  SessionProgressItem,
} from './types';

const QUESTION: Question = {
  id: 'q1',
  type: 'multiple_choice',
  vocab_term_id: 'v1',
  question: 'dog',
  options: ['כלב', 'חתול', 'סוס', 'דג'],
  correct_option: 0,
};

// The two request schemas moved here from apps/server/src/routes/schemas.ts.
// These assertions are that move's proof: the validation rules came across
// unchanged, so the 400s the server returns today are the 400s it returns after.
describe('CreateSessionRequestSchema', () => {
  it('accepts a non-empty enrollment_id', () => {
    expect(CreateSessionRequestSchema.safeParse({ enrollment_id: 'e1' }).success).toBe(true);
  });

  it('rejects a missing enrollment_id', () => {
    expect(CreateSessionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty enrollment_id', () => {
    expect(CreateSessionRequestSchema.safeParse({ enrollment_id: '' }).success).toBe(false);
  });
});

describe('NextStepRequestSchema', () => {
  const valid = { user_id: 'u1', question_id: 'q1', option_index: 0 };

  it('accepts a well-formed step', () => {
    expect(NextStepRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a missing question_id', () => {
    expect(NextStepRequestSchema.safeParse({ user_id: 'u1', option_index: 0 }).success).toBe(false);
  });

  it('rejects a negative option_index', () => {
    expect(NextStepRequestSchema.safeParse({ ...valid, option_index: -1 }).success).toBe(false);
  });

  it('rejects a fractional option_index', () => {
    expect(NextStepRequestSchema.safeParse({ ...valid, option_index: 1.5 }).success).toBe(false);
  });
});

// The response schema the spec flags as most likely to bite: a discriminated
// union whose narrowing the mobile Results screen depends on.
describe('NextStepResponseSchema', () => {
  const position: Position = { position: 3, total: 10 };

  it('parses an in-progress step', () => {
    const parsed = NextStepResponseSchema.safeParse({
      session_id: 's1',
      question: QUESTION,
      position,
      complete: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a completed step and narrows on `complete`', () => {
    const value: NextStepResponse = NextStepResponseSchema.parse({
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
      score: { correct: 9, total: 10 },
      missed_questions: [{ question: QUESTION, correct_answer: 'כלב' }],
      progress: [{ sense_id: 'se1', form: 'dog', translation: 'כלב', level_before: 1, level_after: 2 }],
    });

    // Both the runtime assertion and the narrowing below are the test: if the
    // inferred union stops narrowing on `complete`, this file stops compiling
    // and `npm run typecheck` fails.
    if (!value.complete) throw new Error('expected a completed step');
    const score: Score = value.score;
    const missed: MissedQuestion[] = value.missed_questions;
    expect(score).toEqual({ correct: 9, total: 10 });
    expect(missed[0].correct_answer).toBe('כלב');
    expect(value.question).toBeNull();
    expect(value.progress[0].level_after).toBe(2);
  });

  it('rejects a completed step that omits score', () => {
    const parsed = NextStepResponseSchema.safeParse({
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
      missed_questions: [],
      progress: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a completed step that omits progress', () => {
    const parsed = NextStepResponseSchema.safeParse({
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
      score: { correct: 9, total: 10 },
      missed_questions: [],
    });
    expect(parsed.success).toBe(false);
  });
});

// A compile-time pin, erased at runtime. `complete: false` widening to
// `boolean`, or `score` becoming optional, are the realistic ways an inferred
// type drifts from what apps/mobile expects — and both would fail here during
// `npm run typecheck` rather than in a mobile screen months later.
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

const nextStepShapeIsPinned: Exact<
  NextStepResponse,
  | { session_id: string; question: Question; position: Position; complete: false }
  | {
      session_id: string;
      question: null;
      position: Position;
      complete: true;
      score: Score;
      missed_questions: MissedQuestion[];
      progress: SessionProgressItem[];
    }
> = true;
void nextStepShapeIsPinned;

describe('UsernameSchema', () => {
  it.each(['abc', 'a_b_c', 'user_123', 'a'.repeat(30)])('accepts %s', (value) => {
    expect(UsernameSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(31)],
    ['uppercase', 'Alice'],
    ['a space', 'a b'],
    ['a hyphen', 'a-b'],
    ['Hebrew', 'דנה'],
  ])('rejects %s', (_label, value) => {
    expect(UsernameSchema.safeParse(value).success).toBe(false);
  });
});

describe('CreateUserRequestSchema', () => {
  const valid = {
    username: 'dana',
    display_name: 'דנה',
    age: 34,
    native_language: 'he',
  };

  it('accepts a well-formed request', () => {
    expect(CreateUserRequestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['an empty display_name', { display_name: '' }],
    ['a display_name over 60 characters', { display_name: 'א'.repeat(61) }],
    ['an age below 3', { age: 2 }],
    ['an age above 120', { age: 121 }],
    ['a fractional age', { age: 9.5 }],
    ['an unsupported language', { native_language: 'fr' }],
    ['a malformed username', { username: 'Dana' }],
  ])('rejects %s', (_label, override) => {
    expect(CreateUserRequestSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});

describe('LoginRequestSchema', () => {
  it('accepts a well-formed username', () => {
    expect(LoginRequestSchema.safeParse({ username: 'dana' }).success).toBe(true);
  });

  it('rejects a malformed username', () => {
    expect(LoginRequestSchema.safeParse({ username: 'D' }).success).toBe(false);
  });
});

describe('UserSchema', () => {
  it('accepts a language code it does not narrow', () => {
    const parsed = UserSchema.safeParse({
      id: 'u1',
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'fr',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('TranslationRequestSchema', () => {
  it('accepts a word and a phrase', () => {
    expect(
      TranslationRequestSchema.safeParse({ text: 'book', from: 'en', to: 'he' }).success,
    ).toBe(true);
    expect(
      TranslationRequestSchema.safeParse({ text: 'break a leg', from: 'en', to: 'he' }).success,
    ).toBe(true);
  });

  it('rejects empty, blank and over-long text', () => {
    expect(
      TranslationRequestSchema.safeParse({ text: '', from: 'en', to: 'he' }).success,
    ).toBe(false);
    expect(
      TranslationRequestSchema.safeParse({ text: '   ', from: 'en', to: 'he' }).success,
    ).toBe(false);
    expect(
      TranslationRequestSchema.safeParse({ text: 'a'.repeat(101), from: 'en', to: 'he' }).success,
    ).toBe(false);
  });

  it('accepts text at exactly the 100-character limit', () => {
    expect(
      TranslationRequestSchema.safeParse({ text: 'a'.repeat(100), from: 'en', to: 'he' }).success,
    ).toBe(true);
  });

  it('requires from and to, and accepts only pairs that include Hebrew', () => {
    const ok = (from: string, to: string) =>
      TranslationRequestSchema.safeParse({ text: 'x', from, to }).success;
    expect(ok('en', 'he')).toBe(true);
    expect(ok('he', 'en')).toBe(true);
    expect(ok('ru', 'he')).toBe(true);
    expect(ok('he', 'ru')).toBe(true);
    expect(ok('en', 'ru')).toBe(false);
    expect(ok('it', 'he')).toBe(true);
    expect(ok('he', 'it')).toBe(true);
    expect(ok('en', 'it')).toBe(false);
    expect(ok('ru', 'it')).toBe(false);
    expect(ok('he', 'he')).toBe(false);
    expect(TranslationRequestSchema.safeParse({ text: 'x' }).success).toBe(false);
  });
});

describe('TranslationSenseSchema', () => {
  it('accepts a sense with no part of speech and no example — the sentence case', () => {
    expect(TranslationSenseSchema.safeParse({ translation: 'קראתי ספר על החלל.' }).success).toBe(
      true,
    );
  });

  it('accepts a full sense', () => {
    const result = TranslationSenseSchema.safeParse({
      translation: 'ספר',
      part_of_speech: 'noun',
      example: { source: 'I read a book.', target: 'קראתי ספר.' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty translation', () => {
    expect(TranslationSenseSchema.safeParse({ translation: '' }).success).toBe(false);
  });

  it('rejects a half-filled example', () => {
    expect(
      TranslationSenseSchema.safeParse({ translation: 'ספר', example: { source: 'x' } }).success,
    ).toBe(false);
  });
});

describe('TranslationResponseSchema', () => {
  it('caps senses at five', () => {
    const sense = { translation: 'ספר' };
    const base = { text: 'book', from: 'en', to: 'he', kind: 'word' } as const;
    expect(
      TranslationResponseSchema.safeParse({ ...base, senses: Array(5).fill(sense) }).success,
    ).toBe(true);
    expect(
      TranslationResponseSchema.safeParse({ ...base, senses: Array(6).fill(sense) }).success,
    ).toBe(false);
  });

  it('accepts an empty sense list', () => {
    expect(
      TranslationResponseSchema.safeParse({
        text: 'asdkjhasd',
        from: 'en',
        to: 'he',
        kind: 'word',
        senses: [],
      }).success,
    ).toBe(true);
  });
});

describe('LlmTranslationSchema', () => {
  const sense = { translation: 'ספר', sense_code: 'printed_book' };

  it('is a list of entries, each a lemma with its own ranked senses', () => {
    const result = LlmTranslationSchema.safeParse({
      kind: 'word',
      entries: [{ lemma: 'book', part_of_speech: 'noun', senses: [sense] }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts two entries — the reason the shape is nested at all', () => {
    const result = LlmTranslationSchema.safeParse({
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
    expect(result.success).toBe(true);
  });

  it('treats an empty entry list as the "no translation" answer, not as malformed', () => {
    expect(LlmTranslationSchema.safeParse({ kind: 'word', entries: [] }).success).toBe(true);
  });

  it('rejects an entry with no lemma', () => {
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [{ part_of_speech: 'noun', senses: [sense] }],
      }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [{ lemma: '', part_of_speech: 'noun', senses: [sense] }],
      }).success,
    ).toBe(false);
  });

  it('rejects an entry with an empty sense list — meaningless, not empty', () => {
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [{ lemma: 'book', part_of_speech: 'noun', senses: [] }],
      }).success,
    ).toBe(false);
  });

  it('requires a sense_code on every sense', () => {
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [{ lemma: 'book', part_of_speech: 'noun', senses: [{ translation: 'ספר' }] }],
      }).success,
    ).toBe(false);
  });

  // Five, not the six this asserted before phase 13, and the ceiling is the
  // provider's rather than ours: array caps multiply inside `responseSchema`, and
  // six entries by five senses tipped Gemini past "too many states for serving"
  // the moment `correction` was added — a 400 on every translation call. Measured
  // against the live API. `senses` stays at five, where READ_LIMIT holds it.
  it('caps entries at five and senses at five within an entry', () => {
    const entry = { lemma: 'x', part_of_speech: 'noun', senses: [sense] };
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: Array(5).fill(entry) }).success,
    ).toBe(true);
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: Array(6).fill(entry) }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [{ lemma: 'x', part_of_speech: 'noun', senses: Array(6).fill(sense) }],
      }).success,
    ).toBe(false);
  });

  it('keeps sense_code off the response shape, which is shared with the wire', () => {
    const result = TranslationResponseSchema.safeParse({
      text: 'book',
      from: 'en',
      to: 'he',
      kind: 'word',
      senses: [{ translation: 'ספר', sense_code: 'printed_book' }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.senses[0]).not.toHaveProperty('sense_code');
  });
});

// Phase 12: a lexeme is a lemma AND a part of speech, so part_of_speech moves
// from the sense up to the entry and joins a closed set. It stays on the wire
// sense, which does not move.
describe('part_of_speech on the entry', () => {
  const aSense = { translation: 'X', sense_code: 'make_reservation' };

  it('accepts the ten word classes and rejects spelling variants', () => {
    expect(PartOfSpeechSchema.safeParse('verb').success).toBe(true);
    expect(PartOfSpeechSchema.safeParse('numeral').success).toBe(true);
    expect(PartOfSpeechSchema.safeParse('verb phrase').success).toBe(false);
    expect(PartOfSpeechSchema.safeParse('verb_phrase').success).toBe(false);
    expect(PartOfSpeechSchema.safeParse('Verb').success).toBe(false);
    expect(PartOfSpeechSchema.safeParse('proper_noun').success).toBe(false);
  });

  it('requires part_of_speech on the entry and strips it from the sense', () => {
    expect(LlmEntrySchema.safeParse({ lemma: 'book', senses: [aSense] }).success).toBe(false);
    expect(
      LlmEntrySchema.safeParse({ lemma: 'book', part_of_speech: 'verb', senses: [aSense] })
        .success,
    ).toBe(true);

    const parsed = LlmEntrySchema.parse({
      lemma: 'book',
      part_of_speech: 'verb',
      senses: [{ ...aSense, part_of_speech: 'noun' }],
    });
    expect(parsed.senses[0]).not.toHaveProperty('part_of_speech');
  });

  it('keeps part_of_speech on the wire sense', () => {
    expect(
      TranslationSenseSchema.safeParse({ translation: 'X', part_of_speech: 'noun' }).success,
    ).toBe(true);
  });

  // Five and six, not six and seven: phase 13 lowered the entries cap because
  // Gemini rejects the resulting `responseSchema` otherwise — see the comment on
  // `LlmTranslationSchema.entries`.
  it('accepts five entries and rejects six', () => {
    const entry = { lemma: 'x', part_of_speech: 'noun' as const, senses: [aSense] };
    const make = (n: number) => ({
      kind: 'word' as const,
      entries: Array.from({ length: n }, () => entry),
    });
    expect(LlmTranslationSchema.safeParse(make(5)).success).toBe(true);
    expect(LlmTranslationSchema.safeParse(make(6)).success).toBe(false);
  });
});

describe('the correction block', () => {
  const base = { text: 'thruot', from: 'en', to: 'he', kind: 'word', senses: [] } as const;

  it('is optional on the wire, so today\'s responses still parse', () => {
    expect(TranslationResponseSchema.safeParse(base).success).toBe(true);
  });

  it('is optional on the model schema, so today\'s answers still parse', () => {
    expect(LlmTranslationSchema.safeParse({ kind: 'word', entries: [] }).success).toBe(true);
  });

  it('caps the wire at three alternatives and the model schema at six', () => {
    const alt = (n: number) => Array.from({ length: n }, (_, i) => `alt${i}`);
    const wire = (n: number) =>
      TranslationResponseSchema.safeParse({
        ...base,
        correction: { corrected_form: 'throat', alternatives: alt(n) },
      }).success;
    const model = (n: number) =>
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [],
        correction: { corrected_form: 'throat', alternatives: alt(n) },
      }).success;

    expect(wire(3)).toBe(true);
    expect(wire(4)).toBe(false);
    // Six, not three: `maxItems` travels to Gemini inside responseSchema, so a
    // conforming provider never reaches it — but a provider that ignores it must
    // not 502 a good translation over one surplus decorative alternative.
    // `tidyAlternatives` truncates to three before the answer reaches the wire.
    expect(model(6)).toBe(true);
    expect(model(7)).toBe(false);
  });

  it('caps a form at 100 characters on both, the ceiling learner text already has', () => {
    const long = 'a'.repeat(101);
    expect(
      TranslationResponseSchema.safeParse({
        ...base,
        correction: { corrected_form: long, alternatives: [] },
      }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [],
        correction: { corrected_form: long },
      }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [],
        correction: { corrected_form: 'throat', alternatives: [long] },
      }).success,
    ).toBe(false);
  });

  it('requires alternatives on the wire — what this server publishes is never absent', () => {
    expect(
      TranslationResponseSchema.safeParse({ ...base, correction: { corrected_form: 'throat' } })
        .success,
    ).toBe(false);
  });

  it('rejects a correction with no corrected_form: that is not a correction', () => {
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [],
        correction: { alternatives: ['throat'] },
      }).success,
    ).toBe(false);
  });
});

describe('CreateEnrollmentRequestSchema', () => {
  it('accepts a Hebrew-explained enrollment in English, Russian or Italian', () => {
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'ru' }).success).toBe(true);
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'it' }).success).toBe(true);
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'en' }).success).toBe(true);
  });

  it('rejects an English source in phase 16', () => {
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'en', target_language: 'ru' }).success).toBe(false);
  });

  it('rejects the same language twice and an unknown code', () => {
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'he' }).success).toBe(false);
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'fr' }).success).toBe(false);
  });
});

// Phase 18. The wire sense gained three fields; the MODEL's sense must not. It
// travels to Gemini as responseSchema, where an extra property is either an
// invitation to invent ids or one more state in a schema already at the
// provider's limit (see LlmTranslationSchema's comment).
describe('LlmSenseSchema after phase 18', () => {
  it('still has exactly translation, example and sense_code', () => {
    expect(Object.keys(LlmSenseSchema.shape).sort()).toEqual([
      'example',
      'sense_code',
      'translation',
    ]);
  });
});

describe('TranslationRequestSchema with an enrollment', () => {
  const base = { text: 'окно', from: 'ru', to: 'he' };

  it('accepts a request without enrollment_id, as every client before phase 18 sends', () => {
    expect(TranslationRequestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an enrollment_id', () => {
    expect(TranslationRequestSchema.safeParse({ ...base, enrollment_id: 'e1' }).success).toBe(true);
  });

  it('rejects an empty enrollment_id', () => {
    expect(TranslationRequestSchema.safeParse({ ...base, enrollment_id: '' }).success).toBe(false);
  });
});

describe('TranslationSenseSchema ids', () => {
  it('accepts a sense with ids and a saved flag', () => {
    expect(
      TranslationSenseSchema.safeParse({
        translation: 'חלון',
        sense_id: 's1',
        variant_id: 'v1',
        saved: false,
      }).success,
    ).toBe(true);
  });
});

describe('SaveVocabularyRequestSchema', () => {
  const entry = { sense_id: 's1', variant_id: 'v1' };

  it('accepts one entry and twenty', () => {
    expect(SaveVocabularyRequestSchema.safeParse({ entries: [entry] }).success).toBe(true);
    expect(
      SaveVocabularyRequestSchema.safeParse({ entries: Array(20).fill(entry) }).success,
    ).toBe(true);
  });

  it('rejects none and twenty-one', () => {
    expect(SaveVocabularyRequestSchema.safeParse({ entries: [] }).success).toBe(false);
    expect(
      SaveVocabularyRequestSchema.safeParse({ entries: Array(21).fill(entry) }).success,
    ).toBe(false);
  });

  it('rejects an entry missing its variant', () => {
    expect(SaveVocabularyRequestSchema.safeParse({ entries: [{ sense_id: 's1' }] }).success).toBe(
      false,
    );
  });
});

describe('VocabularyPageQuerySchema', () => {
  it('coerces a query-string limit', () => {
    expect(VocabularyPageQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
  });

  it('leaves both fields optional', () => {
    expect(VocabularyPageQuerySchema.parse({})).toEqual({});
  });

  it.each(['0', '101', 'abc', '1.5', ''])('rejects limit=%j', (limit) => {
    expect(VocabularyPageQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});

describe('VocabularyPageSchema', () => {
  it('accepts a last page', () => {
    expect(VocabularyPageSchema.safeParse({ items: [], next_cursor: null }).success).toBe(true);
  });
});
