import { describe, expect, it } from '@jest/globals';

import {
  AddTargetWordsRequestSchema,
  ChangeTargetDateRequestSchema,
  CreateTargetRequestSchema,
  LearnerDaySchema,
  TargetKindSchema,
  TargetListSchema,
  TargetReadinessSchema,
  TargetRefusalSchema,
  TargetSchema,
  CreateEnrollmentRequestSchema,
  CreateSessionRequestSchema,
  CreateUserRequestSchema,
  StartSessionRequestSchema,
  StartSessionResponseSchema,
  LlmCheckSchema,
  LlmCorrectionSchema,
  LlmContextSchema,
  LlmDistractorsSchema,
  LlmEntrySchema,
  MatchingBoardSchema,
  JudgedAnswerRequestSchema,
  LlmFitJudgeSchema,
  LlmMeaningJudgeSchema,
  LlmTranslationJudgeSchema,
  GapSchema,
  ClozeChoiceQuestionSchema,
  ClozeTypedQuestionSchema,
  SentenceTranslationQuestionSchema,
  LlmPhotoReadingSchema,
  LlmReconciliationSchema,
  LlmSenseMatchSchema,
  LlmSenseSchema,
  LlmTranslationSchema,
  PartOfSpeechSchema,
  PhotoImportCreateRequestSchema,
  PhotoImportItemSchema,
  PhotoImportItemUpdateSchema,
  PhotoImportSchema,
  PhotoImportStatusSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
  SpeechAnswerRequestSchema,
  SpeechAnswerResponseSchema,
  AnswerRecordSchema,
  QuestionSchema,
  SaveVocabularyRequestSchema,
  TranslationCorrectionSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
  TimeZoneRequestSchema,
  PushDeviceRequestSchema,
  PushDeviceUnregisterRequestSchema,
  ReminderSettingsResponseSchema,
  ReminderSettingsSchema,
  TranslationSenseSchema,
  UserSchema,
  UsernameSchema,
  VocabularyPageQuerySchema,
  VocabularyPageSchema,
} from './schemas';
import type {
  MissedQuestion,
  NextStepResponse,
  PendingRetry,
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
  context: null,
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

// Phase 43 (spec D2). The device's capabilities ride on start, each optional.
describe('StartSessionRequestSchema', () => {
  it('accepts no body fields, or both capabilities', () => {
    expect(StartSessionRequestSchema.parse({})).toEqual({});
    expect(StartSessionRequestSchema.parse({ listening: true, speaking: false })).toEqual({ listening: true, speaking: false });
  });

  it('refuses a capability that is not a boolean', () => {
    expect(StartSessionRequestSchema.safeParse({ listening: 'yes' }).success).toBe(false);
  });

  it('answers the session and its status', () => {
    expect(StartSessionResponseSchema.parse({ session_id: 's1', status: 'ready' })).toEqual({ session_id: 's1', status: 'ready' });
  });
});

describe('NextStepRequestSchema', () => {
  const valid = { question_id: 'q1', option_index: 0 };

  it('accepts a well-formed step', () => {
    expect(NextStepRequestSchema.safeParse(valid).success).toBe(true);
  });

  // Phase 29 (spec D12). The actor comes from the session; a body cannot name one.
  it('carries no user id: one sent is dropped', () => {
    expect(NextStepRequestSchema.parse({ ...valid, user_id: 'someone' })).not.toHaveProperty('user_id');
  });

  it('rejects a missing question_id', () => {
    expect(NextStepRequestSchema.safeParse({ option_index: 0 }).success).toBe(false);
  });

  // Phase 38 (spec D4). Whether a typed cloze's hint was opened: optional and boolean.
  it('keeps hint_opened on a text answer, and takes a text answer without it', () => {
    expect(NextStepRequestSchema.parse({ question_id: 'q1', text: 'spent', hint_opened: true })).toEqual({
      question_id: 'q1',
      text: 'spent',
      hint_opened: true,
    });
    expect(NextStepRequestSchema.safeParse({ question_id: 'q1', text: 'spent' }).success).toBe(true);
  });

  it('rejects a hint_opened that is not a boolean', () => {
    expect(NextStepRequestSchema.safeParse({ question_id: 'q1', text: 'spent', hint_opened: 'yes' }).success).toBe(false);
  });

  // Phase 41 (spec D2). The app asks the server to check an unlisted typed-cloze word.
  it('keeps check_fit on a text answer, and refuses one that is not a boolean', () => {
    expect(NextStepRequestSchema.parse({ question_id: 'q1', text: 'edit', check_fit: true })).toEqual({
      question_id: 'q1',
      text: 'edit',
      check_fit: true,
    });
    expect(NextStepRequestSchema.safeParse({ question_id: 'q1', text: 'edit', check_fit: 'yes' }).success).toBe(false);
  });

  // Phase 54 (spec D6). A meet card is answered with `seen: true` and nothing else.
  it('takes `seen: true` for a meet card, and nothing that is not true', () => {
    expect(NextStepRequestSchema.parse({ question_id: 'q1', seen: true })).toEqual({ question_id: 'q1', seen: true });
    expect(NextStepRequestSchema.safeParse({ question_id: 'q1', seen: false }).success).toBe(false);
    expect(NextStepRequestSchema.safeParse({ question_id: 'q1', seen: 'yes' }).success).toBe(false);
    expect(NextStepRequestSchema.safeParse({ seen: true }).success).toBe(false);
    expect(NextStepRequestSchema.safeParse({ question_id: '', seen: true }).success).toBe(false);
  });

  it('rejects a negative option_index', () => {
    expect(NextStepRequestSchema.safeParse({ ...valid, option_index: -1 }).success).toBe(false);
  });

  it('rejects a fractional option_index', () => {
    expect(NextStepRequestSchema.safeParse({ ...valid, option_index: 1.5 }).success).toBe(false);
  });

  // Phase 23. A typed card is answered by its text.
  it('accepts a typed answer, empty included ("show me the answer")', () => {
    expect(NextStepRequestSchema.safeParse({ question_id: 'q1', text: 'casa' }).success).toBe(true);
    expect(NextStepRequestSchema.safeParse({ question_id: 'q1', text: '' }).success).toBe(true);
  });

  it('rejects typed text over 100 characters, and a body with neither answer', () => {
    expect(
      NextStepRequestSchema.safeParse({ question_id: 'q1', text: 'x'.repeat(101) }).success,
    ).toBe(false);
    expect(NextStepRequestSchema.safeParse({ question_id: 'q1' }).success).toBe(false);
  });
});

// Phase 39 (spec D6).
describe('NewMeaningQuestionSchema', () => {
  const card = {
    id: 'q', type: 'new_meaning', vocab_term_id: 'l', question: 'pick up', known_meanings: ['להרים'],
    options: ['לאסוף', 'לבשל', 'לשבור', 'לנגן'], correct_option: 0, context: null,
  };
  it('parses in the question union, with its known meanings', () => {
    const parsed = QuestionSchema.parse(card);
    expect(parsed.type).toBe('new_meaning');
    expect(QuestionSchema.safeParse({ ...card, context: { text: "She'll pick up the kids.", mark: { start: 6, end: 13 } } }).success).toBe(true);
  });
  it('rejects one without known_meanings, or without a context key', () => {
    const { known_meanings: _known, ...bare } = card;
    expect(QuestionSchema.safeParse(bare).success).toBe(false);
    const { context: _context, ...noContext } = card;
    expect(QuestionSchema.safeParse(noContext).success).toBe(false);
  });
});

// Phase 54 (spec D1, D6). The meet card carries the form and its meaning, and nothing to answer with.
describe('MeetQuestionSchema', () => {
  const card = { id: 'e1', type: 'meet', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' };

  it('joins the Question union by its type', () => {
    expect(QuestionSchema.parse(card)).toEqual(card);
  });

  it('needs the form and the meaning', () => {
    expect(QuestionSchema.safeParse({ ...card, meaning: undefined }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...card, question: undefined }).success).toBe(false);
  });

  it('is stored with the seen verdict', () => {
    const record = { question_id: 'e1', is_correct: false, answer_string: '', verdict: 'seen', retry_state: null, retry_answer_string: null, retry_verdict: null };
    expect(AnswerRecordSchema.parse(record).verdict).toBe('seen');
  });
});

describe('QuestionSchema', () => {
  it('parses each of the three types', () => {
    expect(QuestionSchema.parse(QUESTION).type).toBe('multiple_choice');
    expect(
      QuestionSchema.parse({
        id: 'q2', type: 'reverse_choice', vocab_term_id: 'l1', question: 'כלב', part_of_speech: 'noun',
        options: ['dog', 'cat'], correct_option: 0, context: null,
      }).type,
    ).toBe('reverse_choice');
    expect(
      QuestionSchema.parse({
        id: 'q3', type: 'typed_translation', vocab_term_id: 'l1', question: 'כלב', part_of_speech: 'noun',
        answer: 'dog', lemma: 'dog', alternatives: ['hound'], context: null,
      }).type,
    ).toBe('typed_translation');
  });

  it('rejects a typed card without its answer', () => {
    expect(
      QuestionSchema.safeParse({
        id: 'q3', type: 'typed_translation', vocab_term_id: 'l1', question: 'כלב', part_of_speech: 'noun',
        lemma: 'dog', alternatives: [],
      }).success,
    ).toBe(false);
  });
});

describe('LlmDistractorsSchema', () => {
  // Phase 23 (spec D8): a typed item has no wrong options, and its alternatives
  // may be missing without failing the answer.
  it('accepts a typed item with no distractors and no alternatives key', () => {
    expect(LlmDistractorsSchema.safeParse({ items: [{ key: 'q3', distractors: [] }] }).success).toBe(true);
    expect(
      LlmDistractorsSchema.safeParse({ items: [{ key: 'q3', distractors: [], alternatives: ['hound'] }] }).success,
    ).toBe(true);
  });

  // Phase 34 (spec D4, D4a): six wrong options asked, and six is the ceiling the
  // live API was measured to accept alongside the context fields.
  it('accepts six wrong options and rejects a seventh', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(LlmDistractorsSchema.safeParse({ items: [{ key: 'q1', distractors: six }] }).success).toBe(true);
    expect(LlmDistractorsSchema.safeParse({ items: [{ key: 'q1', distractors: [...six, 'g'] }] }).success).toBe(false);
  });

  // Phase 34 (ruling R8). The four context strings made the non-streaming call
  // hang; they left the batch for a call of their own (LlmContextSchema).
  it('carries no context field: the context sentences have their own call', () => {
    expect(Object.keys(LlmDistractorsSchema.shape.items.element.shape)).toEqual([
      'key', 'distractors', 'alternatives', 'sentence', 'gap', 'translation',
    ]);
    const parsed = LlmDistractorsSchema.parse({ items: [{ key: 'q1', distractors: ['a', 'b', 'c'], context: 'Il campo.' }] });
    expect(parsed.items[0]).toEqual({ key: 'q1', distractors: ['a', 'b', 'c'] });
  });
});

// Phase 34 (spec D6, D7, D8, ruling R8). The context call's answer: per item, a
// sentence and its other half, the marked word, or the practised word in a
// Hebrew sentence. Every field optional, so a model that leaves one out fails
// nothing but that item's sentence.
describe('LlmContextSchema', () => {
  it('reads every field, and requires none but the key', () => {
    const item = {
      key: 'q1',
      context: 'Il contadino lavora nel campo.',
      context_translation: 'האיכר עובד בשדה.',
      context_word: 'campo',
      sentence_word: 'בשדה',
    };
    expect(LlmContextSchema.parse({ items: [item] }).items[0]).toEqual(item);
    expect(LlmContextSchema.safeParse({ items: [{ key: 'q1' }] }).success).toBe(true);
    expect(LlmContextSchema.safeParse({ items: [{ context: 'x' }] }).success).toBe(false);
  });

  it('holds at most ten items, a session', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `q${i + 1}` }));
    expect(LlmContextSchema.safeParse({ items: items(10) }).success).toBe(true);
    expect(LlmContextSchema.safeParse({ items: items(11) }).success).toBe(false);
  });
});

// Phase 34 (spec D5). The checker's answer: per item, which options are also
// right, which fit a gap, what a context's marked word means or which words fit
// it, and a sentence's natural translation. Every field optional and uncapped:
// the server checks each list against what it asked (domain/check.ts).
describe('LlmCheckSchema', () => {
  it('reads every field, and requires none but the key', () => {
    const item = {
      key: 'q1',
      options: [true, false, false],
      gap_fits: [false, true],
      context_meaning: 'לנסר',
      context_words: ['download', 'get'],
      natural_translation: "Let's join forces.",
    };
    expect(LlmCheckSchema.parse({ items: [item] }).items[0]).toEqual(item);
    expect(LlmCheckSchema.safeParse({ items: [{ key: 'q1c' }] }).success).toBe(true);
    expect(LlmCheckSchema.safeParse({ items: [{ options: [true] }] }).success).toBe(false);
    expect(LlmCheckSchema.safeParse({ items: [{ key: 'q1', options: ['yes'] }] }).success).toBe(false);
  });

  it('caps nothing: a session of every kind of card fits, and the server counts what it asked', () => {
    const items = Array.from({ length: 24 }, (_, i) => ({ key: `q${i + 1}`, options: Array.from({ length: 6 }, () => false) }));
    expect(LlmCheckSchema.safeParse({ items }).success).toBe(true);
  });
});

// Phase 34 (spec D6, D8, D10). What a card shows beside a bare word or a sentence.
describe('phase 34 question shapes', () => {
  const context = { text: 'He saws the planks every morning.', mark: { start: 3, end: 7 } };
  const cards = {
    multiple_choice: { id: 'q', type: 'multiple_choice', vocab_term_id: 'l', question: 'saw', options: ['לנסר', 'לשבור'], correct_option: 0 },
    reverse_choice: { id: 'q', type: 'reverse_choice', vocab_term_id: 'l', question: 'לנסר', part_of_speech: 'verb', options: ['saw', 'drill'], correct_option: 0 },
    typed_translation: { id: 'q', type: 'typed_translation', vocab_term_id: 'l', question: 'להוריד', part_of_speech: 'verb', answer: 'download', lemma: 'download', alternatives: [] },
    say_translation: { id: 'q', type: 'say_translation', vocab_term_id: 'l', question: 'להוריד', part_of_speech: 'verb', answer: 'download', lemma: 'download', alternatives: [] },
    typed_meaning: { id: 'q', type: 'typed_meaning', vocab_term_id: 'l', question: 'saw', part_of_speech: 'verb', meaning: 'לנסר' },
  };

  it('gives the five bare-word cards a context, marked or not, or null', () => {
    for (const card of Object.values(cards)) {
      expect(QuestionSchema.safeParse({ ...card, context }).success).toBe(true);
      expect(QuestionSchema.safeParse({ ...card, context: { ...context, mark: null } }).success).toBe(true);
      expect(QuestionSchema.safeParse({ ...card, context: null }).success).toBe(true);
      expect(QuestionSchema.safeParse(card).success).toBe(false);
    }
  });

  it('marks the practised word in the Hebrew of a sentence card, or does not', () => {
    const gap = { start: 6, end: 13 };
    const cloze = { id: 'a', type: 'cloze_typed', vocab_term_id: 'l', sentence: "Let's combine forces.", gap, translation: 'בואו נשלב כוחות.', meaning: 'לשלב', answer: 'combine', alternatives: [] };
    const translate = { id: 'a', type: 'sentence_translation', vocab_term_id: 'l', question: 'בואו נשלב כוחות.', meaning: 'לשלב', sentence: "Let's combine forces.", gap, answer: 'combine' };
    for (const card of [cloze, translate]) {
      expect(QuestionSchema.safeParse({ ...card, mark: { start: 5, end: 9 } }).success).toBe(true);
      expect(QuestionSchema.safeParse({ ...card, mark: null }).success).toBe(true);
      expect(QuestionSchema.safeParse(card).success).toBe(false);
    }
  });

  it('gives a listen card and each word of a board its part of speech', () => {
    const listen = { id: 'l', type: 'listen_choice', vocab_term_id: 'v', question: 'saw', options: ['לנסר', 'לשבור'], correct_option: 0 };
    expect(QuestionSchema.safeParse({ ...listen, part_of_speech: 'verb' }).success).toBe(true);
    expect(QuestionSchema.safeParse(listen).success).toBe(false);
    const board = { question_ids: ['m1', 'm2'], words: ['saw', 'main'], parts_of_speech: ['noun', 'adjective'], correct_options: [0, 1] };
    const word = { id: 'm1', type: 'matching', vocab_term_id: 'v', question: 'saw', part_of_speech: 'noun', options: ['מסור', 'ראשי'], correct_option: 0 };
    expect(QuestionSchema.safeParse({ ...word, board }).success).toBe(true);
    expect(MatchingBoardSchema.safeParse({ ...board, parts_of_speech: undefined }).success).toBe(false);
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
      pending_retry: null,
    });
    expect(parsed.success).toBe(true);
  });

  // Phase 34 (spec D9). The card just answered, held for its second try.
  it('parses a step held for a second try, and refuses one that does not say', () => {
    const held = { session_id: 's1', question: QUESTION, position, complete: false };
    expect(NextStepResponseSchema.safeParse({ ...held, pending_retry: { answer: 'abitazione', wording: 'word' } }).success).toBe(true);
    expect(NextStepResponseSchema.safeParse({ ...held, pending_retry: { answer: 'abitazione', wording: 'sense' } }).success).toBe(false);
    expect(NextStepResponseSchema.safeParse(held).success).toBe(false);
  });

  it('parses a completed step and narrows on `complete`', () => {
    const value: NextStepResponse = NextStepResponseSchema.parse({
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
      score: { correct: 9, total: 10 },
      missed_questions: [{ question: QUESTION, correct_answer: 'כלב' }],
      progress: [
        { gloss_id: 'se1', form: 'dog', translation: 'כלב', level_before: 1, level_after: 2, raised: ['written_receptive'] },
      ],
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
  | { session_id: string; question: Question; position: Position; complete: false; pending_retry: PendingRetry | null }
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

describe('TimeZoneRequestSchema', () => {
  it('accepts an IANA name', () => {
    expect(TimeZoneRequestSchema.safeParse({ time_zone: 'Asia/Jerusalem' }).success).toBe(true);
  });

  it.each([
    ['an empty name', { time_zone: '' }],
    ['a name over 64 characters', { time_zone: 'a'.repeat(65) }],
    ['no name', {}],
    ['a number', { time_zone: 3 }],
  ])('rejects %s', (_label, body) => {
    expect(TimeZoneRequestSchema.safeParse(body).success).toBe(false);
  });
});

// Phase 52 (spec D2, D4, D10). The reminder wire: snake_case, bounded on every side.
describe('ReminderSettingsSchema', () => {
  const valid = { enabled: true, daily_target: 2, days: [1, 3, 5], times: ['08:00', '21:30'] };

  it('accepts a schedule, and one with no day at all', () => {
    expect(ReminderSettingsSchema.safeParse(valid).success).toBe(true);
    expect(ReminderSettingsSchema.safeParse({ ...valid, days: [] }).success).toBe(true);
  });

  it('accepts the edges: target 1 and 10, weekdays 1 and 7, 00:00 and 23:59, eight times', () => {
    expect(ReminderSettingsSchema.safeParse({ ...valid, daily_target: 1 }).success).toBe(true);
    expect(ReminderSettingsSchema.safeParse({ ...valid, daily_target: 10 }).success).toBe(true);
    expect(ReminderSettingsSchema.safeParse({ ...valid, days: [1, 7] }).success).toBe(true);
    expect(ReminderSettingsSchema.safeParse({ ...valid, times: ['00:00', '23:59'] }).success).toBe(true);
    const eight = ['06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'];
    expect(ReminderSettingsSchema.safeParse({ ...valid, times: eight }).success).toBe(true);
  });

  it.each([
    ['a target of 0', { daily_target: 0 }],
    ['a target of 11', { daily_target: 11 }],
    ['a fractional target', { daily_target: 1.5 }],
    ['weekday 0', { days: [0] }],
    ['weekday 8', { days: [8] }],
    ['eight weekdays', { days: [1, 2, 3, 4, 5, 6, 7, 7] }],
    ['no time', { times: [] }],
    ['nine times', { times: ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00'] }],
    ['the hour 25', { times: ['25:00'] }],
    ['the minute 60', { times: ['12:60'] }],
    ['a time without its leading zero', { times: ['8:00'] }],
    ['a time with seconds', { times: ['08:00:00'] }],
    ['a camelCase field in place of daily_target', { daily_target: undefined, dailyTarget: 1 }],
  ])('rejects %s', (_label, patch) => {
    expect(ReminderSettingsSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('adds the time zone in the response', () => {
    expect(ReminderSettingsResponseSchema.safeParse({ ...valid, time_zone: 'Asia/Jerusalem' }).success).toBe(true);
    expect(ReminderSettingsResponseSchema.safeParse(valid).success).toBe(false);
  });
});

describe('the push device requests', () => {
  it('accepts an Android token, and a bare token to unregister', () => {
    expect(PushDeviceRequestSchema.safeParse({ token: 'ExponentPushToken[abc]', platform: 'android' }).success).toBe(true);
    expect(PushDeviceUnregisterRequestSchema.safeParse({ token: 'ExponentPushToken[abc]' }).success).toBe(true);
  });

  it.each([
    ['another platform', { token: 't', platform: 'ios' }],
    ['no platform', { token: 't' }],
    ['an empty token', { token: '', platform: 'android' }],
    ['a token over 256 characters', { token: 't'.repeat(257), platform: 'android' }],
  ])('rejects registering with %s', (_label, body) => {
    expect(PushDeviceRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['an empty token', { token: '' }],
    ['a token over 256 characters', { token: 't'.repeat(257) }],
    ['no token', {}],
  ])('rejects unregistering with %s', (_label, body) => {
    expect(PushDeviceUnregisterRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('UserSchema', () => {
  const dana = { id: 'u1', username: 'dana', display_name: 'דנה', age: 34, native_language: 'he', time_zone: 'UTC' };

  it('accepts a language code it does not narrow', () => {
    expect(UserSchema.safeParse({ ...dana, native_language: 'fr' }).success).toBe(true);
  });

  // Phase 52 (spec D1). The zone the server holds, so the app can skip a report that changes nothing.
  it('carries the time zone the server holds', () => {
    expect(UserSchema.parse(dana).time_zone).toBe('UTC');
    const { time_zone: _omitted, ...without } = dana;
    expect(UserSchema.safeParse(without).success).toBe(false);
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
  it('accepts a sense with no part of speech and no examples — the sentence case', () => {
    expect(TranslationSenseSchema.safeParse({ translation: 'קראתי ספר על החלל.' }).success).toBe(
      true,
    );
  });

  it('accepts a full card: one example per member, the alternatives and the key', () => {
    const result = TranslationSenseSchema.safeParse({
      translation: 'ספרים',
      part_of_speech: 'noun',
      examples: [
        { source: 'I read books.', target: 'אני קורא ספרים.' },
        { source: 'The books are open.', target: 'הספרים פתוחים.' },
      ],
      alternatives: ['כרכים'],
      key: 'ספר',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty translation', () => {
    expect(TranslationSenseSchema.safeParse({ translation: '' }).success).toBe(false);
  });

  it('rejects a half-filled example', () => {
    expect(
      TranslationSenseSchema.safeParse({ translation: 'ספר', examples: [{ source: 'x' }] }).success,
    ).toBe(false);
  });

  it('rejects an empty key or alternative', () => {
    expect(TranslationSenseSchema.safeParse({ translation: 'ספרים', key: '' }).success).toBe(false);
    expect(TranslationSenseSchema.safeParse({ translation: 'ספרים', alternatives: [''] }).success).toBe(false);
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

  // Three entries, not the five this asserted before phase 31 (and the six before
  // phase 13), and the ceiling is the provider's rather than ours: array caps
  // multiply inside `responseSchema`, and five entries by five senses tipped
  // Gemini past "too many states for serving" the moment the four phase 31 sense
  // fields were added — a 400 on every translation call. Measured against the
  // live API; the matrix is on `LlmTranslationSchema.entries`. `senses` stays at
  // five, where the lookup's card cap (RESPONSE_CARD_CAP) holds it.
  it('caps entries at three and senses at five within an entry', () => {
    const entry = { lemma: 'x', part_of_speech: 'noun', senses: [sense] };
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: Array(3).fill(entry) }).success,
    ).toBe(true);
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: Array(4).fill(entry) }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [{ lemma: 'x', part_of_speech: 'noun', senses: Array(5).fill(sense) }],
      }).success,
    ).toBe(true);
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

  it('takes the phase 31 fields on a sense, and a sense without them', () => {
    const full = {
      translation: 'מכונית',
      sense_code: 'motor_vehicle',
      alternatives: ['רכב'],
      gloss: 'מכונית',
      definition: 'a road vehicle with an engine',
    };
    expect(LlmTranslationSchema.safeParse({ kind: 'word', entries: [{ lemma: 'car', part_of_speech: 'noun', senses: [full] }] }).success).toBe(true);
    expect(LlmTranslationSchema.safeParse({ kind: 'word', entries: [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'motor_vehicle' }] }] }).success).toBe(true);
    // Zod strips a key the schema does not name, so success alone cannot tell a
    // schema that takes the fields from one that silently drops them.
    const kept = LlmTranslationSchema.parse({ kind: 'word', entries: [{ lemma: 'car', part_of_speech: 'noun', senses: [full] }] });
    expect(kept.entries[0].senses[0]).toEqual(full);
  });

  it("has no citation alternatives: only the rendering call asks for them (see LlmSenseSchema)", () => {
    const parsed = LlmTranslationSchema.parse({
      kind: 'word',
      entries: [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'motor_vehicle', gloss_alternatives: ['רכב'] }] }],
    });
    expect(parsed.entries[0].senses[0]).toEqual({ translation: 'מכונית', sense_code: 'motor_vehicle' });
  });
});

// Phase 31 (spec D4-D6, D9). The second call's rendering takes the first call's three
// fields and gloss_alternatives, absent or null: parseLlmReconciliation parses without dropNulls.
describe('LlmReconciliationSchema', () => {
  it('takes the phase 31 fields as absent or null, since this answer is parsed without dropNulls', () => {
    const base = { sense_code: 'motor_vehicle', translation: 'מכוניות' };
    expect(LlmReconciliationSchema.safeParse({ senses: [{ ...base, gloss: 'מכונית', alternatives: ['רכבים'], gloss_alternatives: ['רכב'], definition: 'a road vehicle' }] }).success).toBe(true);
    expect(LlmReconciliationSchema.safeParse({ senses: [{ ...base, gloss: null, alternatives: null, gloss_alternatives: null, definition: null }] }).success).toBe(true);
    // As above: success alone would also pass a schema that drops the keys.
    const kept = LlmReconciliationSchema.parse({ senses: [{ ...base, gloss: 'מכונית', alternatives: ['רכבים'], gloss_alternatives: ['רכב'], definition: 'a road vehicle' }] });
    expect(kept.senses[0]).toEqual({ ...base, gloss: 'מכונית', alternatives: ['רכבים'], gloss_alternatives: ['רכב'], definition: 'a road vehicle' });
    const nulled = LlmReconciliationSchema.parse({ senses: [{ ...base, gloss: null, alternatives: null, gloss_alternatives: null, definition: null }] });
    expect(nulled.senses[0]).toEqual({ ...base, gloss: null, alternatives: null, gloss_alternatives: null, definition: null });
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

  // Three and four, not five and six: phases 13 and 31 each lowered the entries
  // cap because Gemini rejects the resulting `responseSchema` otherwise — see the
  // comment on `LlmTranslationSchema.entries`.
  it('accepts three entries and rejects four', () => {
    const entry = { lemma: 'x', part_of_speech: 'noun' as const, senses: [aSense] };
    const make = (n: number) => ({
      kind: 'word' as const,
      entries: Array.from({ length: n }, () => entry),
    });
    expect(LlmTranslationSchema.safeParse(make(3)).success).toBe(true);
    expect(LlmTranslationSchema.safeParse(make(4)).success).toBe(false);
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
//
// Phase 31 gave the model's sense three fields of its own (spec D4, D6, D9; the
// citation alternatives are the rendering call's alone) and still none of the
// wire's: no part_of_speech, gloss_id, variant_id or saved.
describe('LlmSenseSchema after phase 18', () => {
  it('has exactly translation, example, sense_code and three of phase 31, none of the wire sense', () => {
    expect(Object.keys(LlmSenseSchema.shape).sort()).toEqual([
      'alternatives',
      'definition',
      'example',
      'gloss',
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
        gloss_id: 's1',
        variant_id: 'v1',
        saved: false,
      }).success,
    ).toBe(true);
  });
});

describe('SaveVocabularyRequestSchema', () => {
  const entry = { gloss_id: 's1', variant_id: 'v1' };

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
    expect(SaveVocabularyRequestSchema.safeParse({ entries: [{ gloss_id: 's1' }] }).success).toBe(
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

describe('phase 25 wire shapes', () => {
  it('parses both speaking questions', () => {
    expect(QuestionSchema.parse({ id: 'r', type: 'read_aloud', vocab_term_id: 'l', question: 'gatto', meaning: 'חתול' }).type).toBe(
      'read_aloud',
    );
    expect(
      QuestionSchema.parse({
        id: 's',
        type: 'say_translation',
        vocab_term_id: 'l',
        question: 'חתול',
        part_of_speech: 'noun',
        answer: 'gatto',
        lemma: 'gatto',
        alternatives: [],
        context: null,
      }).type,
    ).toBe('say_translation');
  });

  it('takes a pass on next-step, and refuses an unknown one', () => {
    expect(NextStepRequestSchema.safeParse({ question_id: 'q', pass: 'skip' }).success).toBe(true);
    expect(NextStepRequestSchema.safeParse({ question_id: 'q', pass: 'later' }).success).toBe(false);
  });

  it('bounds the audio and names the formats', () => {
    const base = { question_id: 'q', mime_type: 'audio/aac' };
    expect(SpeechAnswerRequestSchema.safeParse({ ...base, audio: 'AAAA' }).success).toBe(true);
    expect(SpeechAnswerRequestSchema.parse({ ...base, audio: 'AAAA', user_id: 'u' })).not.toHaveProperty('user_id');
    expect(SpeechAnswerRequestSchema.safeParse({ ...base, audio: '' }).success).toBe(false);
    expect(SpeechAnswerRequestSchema.safeParse({ ...base, audio: 'A'.repeat(270_001) }).success).toBe(false);
    expect(SpeechAnswerRequestSchema.safeParse({ ...base, mime_type: 'audio/wav', audio: 'AAAA' }).success).toBe(false);
  });

  it('answers unheard with no next step', () => {
    expect(SpeechAnswerResponseSchema.safeParse({ heard: 'cane', verdict: 'unheard' }).success).toBe(true);
  });
});

describe('phase 26 photo import schemas', () => {
  it('takes a JPEG as base64, and nothing larger than about 2 MB', () => {
    expect(PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/jpeg', image: 'abc' }).success).toBe(true);
    expect(PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/png', image: 'abc' }).success).toBe(false);
    expect(PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/jpeg', image: '' }).success).toBe(false);
    expect(
      PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/jpeg', image: 'a'.repeat(2_800_001) }).success,
    ).toBe(false);
    expect(
      PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/jpeg', image: 'a'.repeat(2_800_000) }).success,
    ).toBe(true);
  });

  it('refuses an item update that changes nothing', () => {
    expect(PhotoImportItemUpdateSchema.safeParse({}).success).toBe(false);
    expect(PhotoImportItemUpdateSchema.safeParse({ ticked: false }).success).toBe(true);
    expect(PhotoImportItemUpdateSchema.safeParse({ gloss_id: 's1' }).success).toBe(true);
    expect(PhotoImportItemUpdateSchema.safeParse({ gloss_id: '' }).success).toBe(false);
  });

  it('parses a row and an import', () => {
    const item = {
      position: 0,
      text: 'gatto',
      hebrew: 'חתול',
      status: 'ready',
      corrected_form: null,
      options: [{ gloss_id: 's1', variant_id: 'v1', translation: 'חתול', part_of_speech: 'noun' }],
      chosen_gloss_id: 's1',
      ticked: true,
      hebrew_mismatch: false,
      reason: null,
    };
    expect(PhotoImportItemSchema.parse(item)).toEqual(item);
    const summary = { id: 'i1', status: 'looking_up', item_count: 3, settled_count: 1, created_at: '2026-10-07T10:00:00.000Z' };
    expect(PhotoImportSchema.parse({ ...summary, items: [item] }).items).toHaveLength(1);
    expect(PhotoImportStatusSchema.options).toEqual(['reading', 'looking_up', 'ready', 'failed', 'saved', 'discarded']);
  });

  // Phase 31: an option is the lookup's card, key included when the typed form
  // says something else. Options stored before carry none and still parse.
  it("keeps an option's gloss key, and reads an option without one", () => {
    const item = {
      position: 0,
      text: 'gatti',
      hebrew: 'חתולים',
      status: 'ready',
      corrected_form: null,
      options: [
        { gloss_id: 'g1', variant_id: 'v1', translation: 'חתולים', key: 'חתול' },
        { gloss_id: 'g2', variant_id: 'v1', translation: 'חתולות' },
      ],
      chosen_gloss_id: 'g1',
      ticked: true,
      hebrew_mismatch: false,
      reason: null,
    };
    expect(PhotoImportItemSchema.parse(item)).toEqual(item);
  });

  it('reads the model answers: a list of items, and a whole sense number', () => {
    expect(LlmPhotoReadingSchema.parse({ items: [{ text: 'gatto', hebrew: '' }] }).items[0].text).toBe('gatto');
    expect(LlmSenseMatchSchema.safeParse({ sense: 2 }).success).toBe(true);
    expect(LlmSenseMatchSchema.safeParse({ sense: 1.5 }).success).toBe(false);
  });
});

describe('phase 27 Part A schemas', () => {
  it('parses a typed_meaning question', () => {
    const q = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'parlare', part_of_speech: 'verb', meaning: 'לדבר', context: null };
    expect(QuestionSchema.parse(q)).toEqual(q);
  });
  it('bounds a judged answer at 300 characters and needs ids', () => {
    expect(JudgedAnswerRequestSchema.safeParse({ question_id: 'q', text: 'א'.repeat(300) }).success).toBe(true);
    expect(JudgedAnswerRequestSchema.safeParse({ question_id: 'q', text: 'א'.repeat(301) }).success).toBe(false);
    expect(JudgedAnswerRequestSchema.safeParse({ question_id: '', text: 'x' }).success).toBe(false);
    expect(JudgedAnswerRequestSchema.parse({ question_id: 'q', text: 'x', user_id: 'u' })).not.toHaveProperty('user_id');
  });
  it('a next-step body cannot carry a verdict', () => {
    const parsed = NextStepRequestSchema.parse({ question_id: 'q', text: 'x', judged: 'exact' });
    expect(parsed).not.toHaveProperty('judged');
  });
  it('the meaning judge answers one of three verdicts', () => {
    expect(LlmMeaningJudgeSchema.safeParse({ verdict: 'other_sense' }).success).toBe(true);
    expect(LlmMeaningJudgeSchema.safeParse({ verdict: 'misspelled' }).success).toBe(false);
  });
  it('the fit judge answers fits or wrong', () => {
    expect(LlmFitJudgeSchema.safeParse({ verdict: 'fits' }).success).toBe(true);
    expect(LlmFitJudgeSchema.safeParse({ verdict: 'wrong' }).success).toBe(true);
    expect(LlmFitJudgeSchema.safeParse({ verdict: 'right' }).success).toBe(false);
  });
});

describe('phase 27 Part B shapes', () => {
  const gap = { start: 7, end: 16 };
  it('parses each of the three cards', () => {
    expect(
      ClozeChoiceQuestionSchema.safeParse({
        id: 'a', type: 'cloze_choice', vocab_term_id: 'l', sentence: 's', gap, translation: 't', meaning: 'm',
        options: ['a', 'b'], correct_option: 0,
      }).success,
    ).toBe(true);
    expect(
      ClozeTypedQuestionSchema.safeParse({
        id: 'a', type: 'cloze_typed', vocab_term_id: 'l', sentence: 's', gap, translation: 't', meaning: 'm',
        answer: 'x', alternatives: [], mark: null,
      }).success,
    ).toBe(true);
    const translation = {
      id: 'a', type: 'sentence_translation', vocab_term_id: 'l', question: 'q', meaning: 'm', sentence: 's', gap, answer: 'x', mark: null,
    };
    expect(SentenceTranslationQuestionSchema.safeParse(translation).success).toBe(true);
    expect(QuestionSchema.safeParse(translation).success).toBe(true);
  });
  it('a gap starts at zero or later', () => {
    expect(GapSchema.safeParse({ start: -1, end: 3 }).success).toBe(false);
    expect(GapSchema.safeParse({ start: 0, end: 3 }).success).toBe(true);
  });
  it('a distractor item may carry a sentence, a gap and a translation', () => {
    expect(
      LlmDistractorsSchema.safeParse({
        items: [{ key: 'q1', distractors: [], sentence: 'Ieri parlavamo.', gap: 'parlavamo', translation: 'אתמול' }],
      }).success,
    ).toBe(true);
  });
  it('the translation judge answers one of four verdicts', () => {
    expect(LlmTranslationJudgeSchema.safeParse({ verdict: 'misspelled' }).success).toBe(true);
    expect(LlmTranslationJudgeSchema.safeParse({ verdict: 'other_sense' }).success).toBe(false);
  });
});

// Phase 53 (spec D1, D10, D13; rulings R-D9, R-D10). The target wire. A learner day is a real
// calendar day and not only the shape of one: 2026-02-30 used to pass, reach Postgres, which
// raises 22008, and answer 500. A kind is homework or exam, and every request is bounded on
// every side.
describe('LearnerDaySchema', () => {
  it.each([
    '2030-01-08',
    '2026-12-31',
    '2026-02-28',
    // A leap year, and a century year that is one (divisible by 400).
    '2024-02-29',
    '2000-02-29',
    // Years 0-99 are read as written; Date.UTC would remap them to 1900-1999.
    '0099-12-31',
    '9999-12-31',
  ])('accepts %s', (day) => {
    expect(LearnerDaySchema.safeParse(day).success).toBe(true);
  });

  it.each([
    // Days the month does not have.
    '2026-02-30',
    '2026-04-31',
    '2026-01-32',
    '2026-01-00',
    // Months the year does not have.
    '2026-13-01',
    '2026-00-10',
    // The 29th of February of a year that is not a leap year, a century one included.
    '2025-02-29',
    '1900-02-29',
  ])('rejects %s, which has the shape of a day and is not one', (day) => {
    expect(LearnerDaySchema.safeParse(day).success).toBe(false);
  });

  it.each([
    ['one-digit parts', '2026-2-3'],
    ['no dashes', '20260203'],
    ['slashes', '2026/02/03'],
    ['a time of day', '2026-02-03T00:00:00Z'],
    ['a trailing newline', '2026-02-03\n'],
    ['a leading space', ' 2026-02-03'],
    ['a five-digit year', '12026-02-03'],
    ['an empty string', ''],
    ['a number', 20260203],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(LearnerDaySchema.safeParse(value).success).toBe(false);
  });
});

describe('the target requests', () => {
  const entry = { gloss_id: 'g1', variant_id: 'v1' };
  const create = { kind: 'exam', due_on: '2030-01-13', photo_import_ids: ['i1'], entries: [entry] };
  const ids = (count: number) => Array.from({ length: count }, (_, index) => 'i' + index);
  const entries = (count: number) => Array(count).fill(entry);

  it('accepts a create of either kind, with photos and typed words', () => {
    expect(CreateTargetRequestSchema.parse(create)).toEqual(create);
    expect(CreateTargetRequestSchema.safeParse({ ...create, kind: 'homework' }).success).toBe(true);
  });

  // Ruling R-D10: only the save can tell that a photo holds no word, so the schema lets a create
  // with no word named through, and the service answers it with invalid target.
  it('accepts a create that names no photo and no word', () => {
    expect(CreateTargetRequestSchema.safeParse({ ...create, photo_import_ids: [], entries: [] }).success).toBe(true);
  });

  it.each([
    ['an unknown kind', { kind: 'quiz' }],
    ['no kind', { kind: undefined }],
    ['no date', { due_on: undefined }],
    ['a date in another format', { due_on: '13/01/2030' }],
    ['a day that is not on the calendar', { due_on: '2026-02-30' }],
    ['no photo list', { photo_import_ids: undefined }],
    ['no word list', { entries: undefined }],
    ['an empty photo import id', { photo_import_ids: [''] }],
    ['an entry with no variant', { entries: [{ gloss_id: 'g1' }] }],
    ['an entry with no gloss', { entries: [{ variant_id: 'v1' }] }],
  ])('rejects a create with %s', (_label, override) => {
    expect(CreateTargetRequestSchema.safeParse({ ...create, ...override }).success).toBe(false);
  });

  it('takes ten photos and fifty typed words, and not one more of either', () => {
    expect(CreateTargetRequestSchema.safeParse({ ...create, photo_import_ids: ids(10), entries: entries(50) }).success).toBe(true);
    expect(CreateTargetRequestSchema.safeParse({ ...create, photo_import_ids: ids(11) }).success).toBe(false);
    expect(CreateTargetRequestSchema.safeParse({ ...create, entries: entries(51) }).success).toBe(false);
  });

  it('accepts an add of photos, of typed words, and of both', () => {
    expect(AddTargetWordsRequestSchema.safeParse({ photo_import_ids: ['i1'], entries: [] }).success).toBe(true);
    expect(AddTargetWordsRequestSchema.safeParse({ photo_import_ids: [], entries: [entry] }).success).toBe(true);
    expect(AddTargetWordsRequestSchema.safeParse({ photo_import_ids: ['i1'], entries: [entry] }).success).toBe(true);
  });

  it('refuses an add that brings nothing', () => {
    expect(AddTargetWordsRequestSchema.safeParse({ photo_import_ids: [], entries: [] }).success).toBe(false);
  });

  it.each([
    ['no photo list', { entries: [entry] }],
    ['no word list', { photo_import_ids: ['i1'] }],
    ['an empty photo import id', { photo_import_ids: [''], entries: [] }],
    ['an entry with no variant', { photo_import_ids: [], entries: [{ gloss_id: 'g1' }] }],
  ])('rejects an add with %s', (_label, body) => {
    expect(AddTargetWordsRequestSchema.safeParse(body).success).toBe(false);
  });

  it('has the same bounds on an add as on a create', () => {
    expect(AddTargetWordsRequestSchema.safeParse({ photo_import_ids: ids(10), entries: entries(50) }).success).toBe(true);
    expect(AddTargetWordsRequestSchema.safeParse({ photo_import_ids: ids(11), entries: [] }).success).toBe(false);
    expect(AddTargetWordsRequestSchema.safeParse({ photo_import_ids: [], entries: entries(51) }).success).toBe(false);
  });

  it('moves a date to a real day, and only that', () => {
    expect(ChangeTargetDateRequestSchema.parse({ due_on: '2030-02-01' })).toEqual({ due_on: '2030-02-01' });
    for (const body of [{}, { due_on: '2030-2-1' }, { due_on: '2026-02-30' }, { due_on: '2026-13-01' }, { due_on: 20300201 }]) {
      expect(ChangeTargetDateRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('the target read models', () => {
  const summary = { id: 't1', kind: 'homework', due_on: '2030-01-13', days_left: 5, word_count: 2, ready_count: 1 };
  const word = { gloss_id: 'g1', form: 'apple', meaning: 'תפוח', readiness: 'ready' };

  it('names two kinds and four readiness levels, in the order the app shows them', () => {
    expect(TargetKindSchema.options).toEqual(['homework', 'exam']);
    expect(TargetReadinessSchema.options).toEqual(['not_started', 'on_the_way', 'almost', 'ready']);
  });

  it('parses the list of active targets with the learner day it was read on', () => {
    const list = { today: '2030-01-08', targets: [summary] };
    expect(TargetListSchema.parse(list)).toEqual(list);
    expect(TargetListSchema.parse({ today: '2030-01-08', targets: [] }).targets).toEqual([]);
  });

  it('parses a target with its words, in the order given', () => {
    const second = { ...word, gloss_id: 'g2', form: 'bread', meaning: 'לחם', readiness: 'not_started' };
    const target = { ...summary, words: [word, second] };
    expect(TargetSchema.parse(target).words.map((each) => each.gloss_id)).toEqual(['g1', 'g2']);
    expect(TargetSchema.safeParse({ ...summary, words: [{ ...word, readiness: 'nearly' }] }).success).toBe(false);
    expect(TargetSchema.safeParse({ ...summary, days_left: 1.5, words: [] }).success).toBe(false);
  });
});

// The 400 of a target request says why only when it is an invalid target.
describe('TargetRefusalSchema', () => {
  it('parses the three bodies a target request can be refused with', () => {
    expect(TargetRefusalSchema.parse({ error: 'invalid request' })).toEqual({ error: 'invalid request' });
    expect(TargetRefusalSchema.parse({ error: 'invalid vocabulary entry' })).toEqual({ error: 'invalid vocabulary entry' });
    for (const reason of ['due_date', 'no_words', 'unknown_import']) {
      expect(TargetRefusalSchema.parse({ error: 'invalid target', reason })).toEqual({ error: 'invalid target', reason });
    }
  });

  it('rejects a reason it does not name, and a body with no error', () => {
    expect(TargetRefusalSchema.safeParse({ error: 'invalid target', reason: 'because' }).success).toBe(false);
    expect(TargetRefusalSchema.safeParse({ reason: 'due_date' }).success).toBe(false);
  });
});
