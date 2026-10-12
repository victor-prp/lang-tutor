import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

/**
 * Phase 34 (spec §2, Data). The columns and checks of 0028_ambiguous_questions.
 *
 * Every refusal names its constraint, not just "throws": a column the migration
 * forgot would make any insert throw, and a test that only says `rejects`
 * would pass for that reason too. Each refusal is paired with the row it
 * differs from by one field, which the table takes.
 */

const E = enrollmentOf('u_1');

let t: TestDb;
let glossId: string;
let variantId: string;
let senseId: string;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  const kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [{ senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null }],
      },
    ],
  });
  glossId = kite.glossIds[0];
  variantId = kite.variantIds[0];
  senseId = kite.senseIds[0];
});
afterEach(async () => {
  await t.close();
});

/** A text[] literal from bound values: drizzle spreads a bare array into `($1, $2)`. */
const textArray = (items: string[]) =>
  items.length === 0 ? sql`'{}'::text[]` : sql`ARRAY[${sql.join(items.map((item) => sql`${item}`), sql`, `)}]::text[]`;

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

describe('dict_var_translations.accepted_answers (spec D1)', () => {
  const store = (answers: string[]) =>
    t.db.execute(sql`
      update dict_var_translations set accepted_answers = ${textArray(answers)}
      where variant_id = ${variantId} and sense_id = ${senseId}`);

  it('starts empty, with no form and no stamp, on every existing rendering', async () => {
    const rows = await t.db.execute<{ accepted_answers: string[]; answer_form: string | null; accepted_at: string | null }>(
      sql`select accepted_answers, answer_form, accepted_at from dict_var_translations where variant_id = ${variantId}`,
    );
    expect(rows.rows).toEqual([{ accepted_answers: [], answer_form: null, accepted_at: null }]);
  });

  it('takes ten accepted answers', async () => {
    await store(Array.from({ length: 10 }, (_, i) => `w${i}`));
  });

  it('refuses eleven', async () => {
    await expect(store(Array.from({ length: 11 }, (_, i) => `w${i}`))).rejects.toThrow(
      violating('dict_var_translations_accepted_answers_cap'),
    );
  });
});

describe('questions (spec D1, D6, D8)', () => {
  let n = 0;
  type Row = Partial<{
    type: string;
    prompt: string | null;
    alternatives: string[] | null;
    sentence: string | null;
    sentenceTranslation: string | null;
    gapStart: number | null;
    gapEnd: number | null;
    options: string | null;
    context: string | null;
    contextTranslation: string | null;
    contextMarkStart: number | null;
    contextMarkEnd: number | null;
    sentenceMarkStart: number | null;
    sentenceMarkEnd: number | null;
    answerForm: string | null;
  }>;

  // A typed translation card unless a field says otherwise: a Hebrew prompt, no options.
  const insert = (row: Row) => {
    const r = {
      type: 'typed_translation',
      prompt: 'עפיפון',
      alternatives: [] as string[] | null,
      sentence: null,
      sentenceTranslation: null,
      gapStart: null,
      gapEnd: null,
      options: null,
      context: null,
      contextTranslation: null,
      contextMarkStart: null,
      contextMarkEnd: null,
      sentenceMarkStart: null,
      sentenceMarkEnd: null,
      answerForm: null,
      ...row,
    };
    return t.db.execute(sql`
      insert into questions
        (id, gloss_id, prompt_variant_id, target_language, user_language_code, type, prompt, alternatives, options,
         sentence, sentence_translation, gap_start, gap_end,
         context, context_translation, context_mark_start, context_mark_end,
         sentence_mark_start, sentence_mark_end, answer_form)
      values
        (${`q${++n}`}, ${glossId}, ${variantId}, 'en', 'he', ${r.type}, ${r.prompt},
         ${r.alternatives === null ? sql`null::text[]` : textArray(r.alternatives)}, ${r.options}::jsonb,
         ${r.sentence}, ${r.sentenceTranslation}, ${r.gapStart}, ${r.gapEnd},
         ${r.context}, ${r.contextTranslation}, ${r.contextMarkStart}, ${r.contextMarkEnd},
         ${r.sentenceMarkStart}, ${r.sentenceMarkEnd}, ${r.answerForm})`);
  };

  const OPTIONS = JSON.stringify([
    { position: 0, text: 'kite', is_correct: true },
    { position: 1, text: 'sky', is_correct: false },
    { position: 2, text: 'wind', is_correct: false },
    { position: 3, text: 'string', is_correct: false },
  ]);
  const CLOZE = {
    sentence: 'We flew a kite today.',
    sentenceTranslation: 'עפנו עם עפיפון היום.',
    gapStart: 10,
    gapEnd: 14,
  };

  describe('alternatives', () => {
    it.each(['typed_translation', 'say_translation', 'cloze_typed'])('%s takes ten', async (type) => {
      await insert({ type, alternatives: Array.from({ length: 10 }, (_, i) => `w${i}`), ...(type === 'cloze_typed' ? CLOZE : {}) });
    });
    it.each(['typed_translation', 'say_translation', 'cloze_typed'])('%s refuses eleven', async (type) => {
      await expect(
        insert({ type, alternatives: Array.from({ length: 11 }, (_, i) => `w${i}`), ...(type === 'cloze_typed' ? CLOZE : {}) }),
      ).rejects.toThrow(violating('questions_shape_valid'));
    });
  });

  describe('a context sentence (spec D6)', () => {
    const CONTEXT = { context: 'הרוח נשבה והעפיפון עלה.', contextTranslation: 'The wind blew and the kite rose.' };

    it.each([
      ['typed_translation', {}],
      ['say_translation', {}],
      ['reverse_choice', { options: OPTIONS, alternatives: null }],
      ['typed_meaning', { alternatives: null }],
      ['multiple_choice', { options: OPTIONS, prompt: null, alternatives: null }],
    ] as [string, Row][])('%s may carry one, with its mark', async (type, shape) => {
      await insert({ type, ...shape, ...CONTEXT, contextMarkStart: 12, contextMarkEnd: 18 });
    });

    it.each([
      ['dictation', { alternatives: null }],
      ['read_aloud', { alternatives: null }],
      ['cloze_typed', { ...CLOZE }],
      ['sentence_translation', { ...CLOZE, alternatives: null }],
      ['listen_choice', { options: OPTIONS, prompt: null, alternatives: null }],
      ['cloze_choice', { ...CLOZE, options: OPTIONS, alternatives: null }],
    ] as [string, Row][])('%s may not', async (type, shape) => {
      await insert({ type, ...shape });
      // Each column on its own: the sentence alone, with its translation, with its mark.
      await expect(insert({ type, ...shape, context: CONTEXT.context })).rejects.toThrow(violating('questions_shape_valid'));
      await expect(insert({ type, ...shape, ...CONTEXT })).rejects.toThrow(violating('questions_shape_valid'));
      await expect(insert({ type, ...shape, context: CONTEXT.context, contextMarkStart: 12, contextMarkEnd: 18 })).rejects.toThrow(
        violating('questions_shape_valid'),
      );
    });

    it('may carry a context without a mark, which is a word the service could not find', async () => {
      await insert({ ...CONTEXT });
    });

    it('may not carry a mark of one end only', async () => {
      await expect(insert({ ...CONTEXT, contextMarkStart: 12 })).rejects.toThrow(violating('questions_marks_valid'));
      await expect(insert({ ...CONTEXT, contextMarkEnd: 18 })).rejects.toThrow(violating('questions_marks_valid'));
    });

    it('may not mark a word outside its sentence, or an empty or reversed one', async () => {
      await expect(insert({ ...CONTEXT, contextMarkStart: 12, contextMarkEnd: 99 })).rejects.toThrow(violating('questions_marks_valid'));
      await expect(insert({ ...CONTEXT, contextMarkStart: 5, contextMarkEnd: 5 })).rejects.toThrow(violating('questions_marks_valid'));
      await expect(insert({ ...CONTEXT, contextMarkStart: 9, contextMarkEnd: 5 })).rejects.toThrow(violating('questions_marks_valid'));
      await expect(insert({ ...CONTEXT, contextMarkStart: -1, contextMarkEnd: 5 })).rejects.toThrow(violating('questions_marks_valid'));
    });

    it('may not mark a word of a sentence it does not have', async () => {
      await expect(insert({ contextMarkStart: 0, contextMarkEnd: 3 })).rejects.toThrow(violating('questions_marks_valid'));
      await expect(insert({ contextTranslation: CONTEXT.contextTranslation })).rejects.toThrow(violating('questions_marks_valid'));
    });
  });

  describe('a marked word in the Hebrew sentence (spec D8)', () => {
    it.each(['cloze_typed', 'sentence_translation'])('%s may carry one, and may leave it out', async (type) => {
      const shape = { type, ...CLOZE, alternatives: type === 'cloze_typed' ? [] : null };
      await insert(shape);
      await insert({ ...shape, sentenceMarkStart: 5, sentenceMarkEnd: 10 });
    });

    // The one type with a Hebrew sentence that does not ask it: only the shape
    // check refuses it, the marks check being satisfied.
    it('cloze_choice may not', async () => {
      const shape = { type: 'cloze_choice', ...CLOZE, options: OPTIONS, alternatives: null };
      await insert(shape);
      await expect(insert({ ...shape, sentenceMarkStart: 5, sentenceMarkEnd: 10 })).rejects.toThrow(
        violating('questions_shape_valid'),
      );
    });

    // These have no Hebrew sentence to mark, so a mark is refused twice over.
    it.each([
      ['typed_translation', {}],
      ['typed_meaning', { alternatives: null }],
      ['dictation', { alternatives: null }],
    ] as [string, Row][])('%s may not', async (type, shape) => {
      await insert({ type, ...shape });
      await expect(insert({ type, ...shape, sentenceMarkStart: 1, sentenceMarkEnd: 3 })).rejects.toThrow(
        expect.objectContaining({
          cause: expect.objectContaining({ message: expect.stringMatching(/questions_(marks|shape)_valid/) }),
        }),
      );
    });

    const cloze = { type: 'cloze_typed', ...CLOZE };
    it('may not mark one end only, or a word outside the sentence', async () => {
      await expect(insert({ ...cloze, sentenceMarkStart: 5 })).rejects.toThrow(violating('questions_marks_valid'));
      await expect(insert({ ...cloze, sentenceMarkEnd: 10 })).rejects.toThrow(violating('questions_marks_valid'));
      await expect(insert({ ...cloze, sentenceMarkStart: 5, sentenceMarkEnd: 99 })).rejects.toThrow(violating('questions_marks_valid'));
      await expect(insert({ ...cloze, sentenceMarkStart: 8, sentenceMarkEnd: 8 })).rejects.toThrow(violating('questions_marks_valid'));
    });
  });

  it('keeps the form a card asks for (spec D2) on any type', async () => {
    await insert({ answerForm: 'ore' });
    await insert({ type: 'dictation', alternatives: null, answerForm: 'ore' });
  });
});

describe('answers.retry_* (spec D9)', () => {
  let sessionId: string;

  beforeEach(async () => {
    await t.db.execute(sql`
      insert into questions (id, gloss_id, prompt_variant_id, target_language, user_language_code, type, prompt, alternatives)
      values ('q_typed', ${glossId}, ${variantId}, 'en', 'he', 'typed_translation', 'עפיפון', '{}'::text[])`);
    await t.db.execute(sql`
      insert into questions (id, gloss_id, prompt_variant_id, target_language, user_language_code, type, options)
      values ('q_choice', ${glossId}, ${variantId}, 'en', 'he', 'multiple_choice',
              ${JSON.stringify([
                { position: 0, text: 'kite', is_correct: true },
                { position: 1, text: 'sky', is_correct: false },
                { position: 2, text: 'wind', is_correct: false },
                { position: 3, text: 'string', is_correct: false },
              ])}::jsonb)`);
    const session = await t.db.execute<{ id: string }>(sql`
      insert into sessions (user_id, enrollment_id, status, source, listening, speaking) values ('u_1', ${E}, 'ready', 'list', false, false) returning id`);
    sessionId = session.rows[0].id;
    await t.db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
      values (${sessionId}, 0, 'q_typed', '{}'), (${sessionId}, 1, 'q_choice', '{0,1,2,3}')`);
  });

  type Answer = Partial<{
    position: number;
    verdict: string | null;
    retryState: string | null;
    retryText: string | null;
    retryVerdict: string | null;
  }>;
  const answer = (over: Answer) => {
    const a = { position: 0, verdict: 'alternative', retryState: null, retryText: null, retryVerdict: null, ...over };
    const choice = a.position === 1;
    return t.db.execute(sql`
      insert into answers
        (session_id, position, question_id, selected_option_position, typed_text, verdict, retry_state, retry_text, retry_verdict)
      values
        (${sessionId}, ${a.position}, ${choice ? 'q_choice' : 'q_typed'}, ${choice ? 0 : null}, ${choice ? null : 'allora'},
         ${choice ? null : a.verdict}, ${a.retryState}, ${a.retryText}, ${a.retryVerdict})`);
  };

  it('takes an answer with no retry, and leaves it null', async () => {
    await answer({ verdict: 'exact' });
    const rows = await t.db.execute(sql`select retry_state, retry_text, retry_verdict from answers`);
    expect(rows.rows).toEqual([{ retry_state: null, retry_text: null, retry_verdict: null }]);
  });

  it('takes a pending retry on an alternative verdict', async () => {
    await answer({ retryState: 'pending' });
  });

  it('takes a resolved retry on an alternative verdict', async () => {
    await answer({ retryState: 'resolved', retryText: 'ho', retryVerdict: 'exact' });
  });

  it('refuses a retry state it does not know', async () => {
    await expect(answer({ retryState: 'open' })).rejects.toThrow(violating('answers_retry_state_known'));
  });

  it.each(['exact', 'near_miss', 'wrong', 'understood', 'gave_up', 'skipped'])(
    'refuses a pending retry on a %s verdict',
    async (verdict) => {
      await expect(answer({ verdict, retryState: 'pending' })).rejects.toThrow(violating('answers_retry_only_on_alternative'));
    },
  );

  it('refuses a retry on a choice answer, whose verdict is null', async () => {
    // The trap in `retry_state is null or verdict = 'alternative'`: a null verdict
    // makes the second half null, and a CHECK passes on null.
    await expect(answer({ position: 1, retryState: 'pending' })).rejects.toThrow(
      violating('answers_retry_only_on_alternative'),
    );
  });

  it('refuses a resolved retry without its text, or without its verdict', async () => {
    await expect(answer({ retryState: 'resolved', retryVerdict: 'exact' })).rejects.toThrow(
      violating('answers_retry_resolved_complete'),
    );
    await expect(answer({ retryState: 'resolved', retryText: 'ho' })).rejects.toThrow(
      violating('answers_retry_resolved_complete'),
    );
  });

  it('refuses a retry text or verdict on a pending retry, or on none', async () => {
    await expect(answer({ retryState: 'pending', retryText: 'ho' })).rejects.toThrow(violating('answers_retry_resolved_complete'));
    await expect(answer({ retryState: 'pending', retryVerdict: 'exact' })).rejects.toThrow(
      violating('answers_retry_resolved_complete'),
    );
    await expect(answer({ retryText: 'ho' })).rejects.toThrow(violating('answers_retry_resolved_complete'));
    await expect(answer({ retryVerdict: 'exact' })).rejects.toThrow(violating('answers_retry_resolved_complete'));
  });

  it.each(['exact', 'near_miss', 'alternative', 'wrong', 'understood', 'gave_up', 'skipped'])(
    'takes %s as a retry verdict',
    async (retryVerdict) => {
      await answer({ retryState: 'resolved', retryText: 'ho', retryVerdict });
    },
  );

  it('refuses a retry verdict it does not know', async () => {
    await expect(answer({ retryState: 'resolved', retryText: 'ho', retryVerdict: 'maybe' })).rejects.toThrow(
      violating('answers_retry_verdict_known'),
    );
  });

  it('takes a retry text of 300 characters', async () => {
    await answer({ retryState: 'resolved', retryText: 'x'.repeat(300), retryVerdict: 'wrong' });
  });

  it('refuses a retry text of 301', async () => {
    await expect(answer({ retryState: 'resolved', retryText: 'x'.repeat(301), retryVerdict: 'wrong' })).rejects.toThrow(
      violating('answers_retry_text_length'),
    );
  });
});
