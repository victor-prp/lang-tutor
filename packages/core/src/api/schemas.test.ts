import { describe, expect, it } from '@jest/globals';

import {
  CreateSessionRequestSchema,
  CreateUserRequestSchema,
  LlmTranslationSchema,
  LoginRequestSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
  TranslationSenseSchema,
  UserSchema,
  UsernameSchema,
} from './schemas';
import type { MissedQuestion, NextStepResponse, Position, Question, Score } from './types';

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
  it('accepts a non-empty user_id', () => {
    expect(CreateSessionRequestSchema.safeParse({ user_id: 'u1' }).success).toBe(true);
  });

  it('rejects a missing user_id', () => {
    expect(CreateSessionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty user_id', () => {
    expect(CreateSessionRequestSchema.safeParse({ user_id: '' }).success).toBe(false);
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
  });

  it('rejects a completed step that omits score', () => {
    const parsed = NextStepResponseSchema.safeParse({
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
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
    target_language: 'en',
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
    ['an unsupported language', { target_language: 'fr' }],
    ['a malformed username', { username: 'Dana' }],
  ])('rejects %s', (_label, override) => {
    expect(CreateUserRequestSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  // Deliberately accepted at the schema level: the service and a database
  // CHECK reject it. A refinement here would not survive JSON Schema output.
  it('does not itself reject a matching language pair', () => {
    expect(
      CreateUserRequestSchema.safeParse({ ...valid, target_language: 'he' }).success,
    ).toBe(true);
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
      native_language: 'he',
      target_language: 'fr',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('TranslationRequestSchema', () => {
  it('accepts a word and a phrase', () => {
    expect(TranslationRequestSchema.safeParse({ text: 'book' }).success).toBe(true);
    expect(TranslationRequestSchema.safeParse({ text: 'break a leg' }).success).toBe(true);
  });

  it('rejects empty, blank and over-long text', () => {
    expect(TranslationRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(TranslationRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(TranslationRequestSchema.safeParse({ text: 'a'.repeat(101) }).success).toBe(false);
  });

  it('accepts text at exactly the 100-character limit', () => {
    expect(TranslationRequestSchema.safeParse({ text: 'a'.repeat(100) }).success).toBe(true);
  });

  it('treats direction as an optional override with two values', () => {
    expect(TranslationRequestSchema.safeParse({ text: 'book' }).success).toBe(true);
    expect(TranslationRequestSchema.safeParse({ text: 'book', direction: 'he_en' }).success).toBe(
      true,
    );
    expect(TranslationRequestSchema.safeParse({ text: 'book', direction: 'fr_he' }).success).toBe(
      false,
    );
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
    const base = { text: 'book', direction: 'en_he', kind: 'word' } as const;
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
        direction: 'en_he',
        kind: 'word',
        senses: [],
      }).success,
    ).toBe(true);
  });
});

describe('LlmTranslationSchema', () => {
  it('is the response shape minus text and direction', () => {
    const result = LlmTranslationSchema.safeParse({
      kind: 'word',
      senses: [{ translation: 'ספר', part_of_speech: 'noun' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a model that invents its own direction', () => {
    const result = LlmTranslationSchema.safeParse({
      kind: 'word',
      direction: 'he_en',
      senses: [{ translation: 'ספר' }],
    });
    // Extra keys are stripped rather than rejected; what matters is that the
    // server's own direction is never overwritten by the model's.
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('direction');
  });
});
