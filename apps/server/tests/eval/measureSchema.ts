/**
 * Phase 34 (spec D4a). Does the live API accept the session batch's response
 * schema at full size? Run it before a field is added to LlmDistractorsSchema,
 * and again after:
 *
 *   cd apps/server && npx tsx tests/eval/measureSchema.ts [flags]
 *
 * It sends the REAL artifact: `distractorItems` over hand-made rows (ten items,
 * every task kind), `buildDistractorPrompt`, and `createGeminiClient`, whose
 * `toGeminiSchema` turns the Zod schema into `responseSchema`. Gemini refuses a
 * schema whose array caps multiply into too many states with a 400, which fails
 * every call, and MockServer, which never validates a schema, cannot show it
 * (see the comment above `entries` in packages/core/src/api/schemas.ts). So this
 * is the only check that can.
 *
 * Standalone tsx script, not a test: it makes a network call and is part of
 * neither `npm test` nor `npm run eval`. Needs GEMINI_API_KEY and GEMINI_MODEL,
 * and refuses to run against MockServer.
 *
 * Flags, for measuring a variant without editing the schema:
 *   --oversized        every field of an item twice and `distractors` capped at 20.
 *                      It exists to prove the script can report a refusal: a check
 *                      that cannot fail proves nothing.
 *   --distractors N    cap `distractors` at N (the fallback ladder is 6, 5, 4).
 *   --extra N          add N more optional string fields: the headroom left.
 *   --context          measure the context call instead (LlmContextSchema, ruling
 *                      R8): ten items of every kind through buildContextPrompt, and
 *                      how each would be kept. Run it several times: the batch's
 *                      context strings hung the call without a 400 (see the comment
 *                      above LlmDistractorsSchema), so the wait is a measurement too.
 *   --check            measure the checker call instead (LlmCheckSchema, spec D5,
 *                      ruling R8): a full session's sixteen checks through buildCheckPrompt,
 *                      within production's budget for it, and what each answer says.
 *                      Run it several times, for the same reason as --context.
 *   --required         with --check: every field of an item required, the variant
 *                      ruling R8 names if the optional fields make the call hang.
 *
 * The prompt is the production one, which asks a choice item for six wrong
 * answers (spec D4), so the answer is as long as a real one.
 *
 * Exit status: 0 accepted, 1 refused (a 400), 2 any other provider failure (the
 * measurement is then inconclusive), 3 accepted but the answer does not parse.
 */
import { z, type ZodType } from 'zod';

import type { QuestionType } from '@lang-tutor/core/domain';
import { LlmCheckSchema, LlmContextSchema, LlmDistractorsSchema } from '@lang-tutor/core/api/schemas';

import { loadGeminiConfig } from '../../src/config';
import { buildCheckPrompt, parseCheck, readCheck, type CheckItem } from '../../src/domain/check';
import { CHECKER_CALL_BUDGET_MS, CONTEXT_CALL_BUDGET_MS, SESSION_GENERATION_THINKING } from '../../src/domain/jobs';
import {
  buildContextPrompt,
  contextItemFor,
  markFor,
  parseLlmContext,
  resolveContext,
  wordMapFor,
  type ContextItem,
} from '../../src/domain/context';
import {
  buildDistractorPrompt,
  distractorItems,
  keyOf,
  parseLlmDistractors,
  type GenerationContext,
  type RecentSentences,
  type Task,
} from '../../src/domain/distractors';
import { createGeminiClient, toGeminiSchema } from '../../src/providers/gemini';

/** The session batch's production budget (composition.ts: sessionGenerationTimeoutMs). */
const TIMEOUT_MS = 300_000;

/** The context call's fields (spec D6, D8). */
const CONTEXT_FIELDS = ['context', 'context_translation', 'context_word', 'sentence_word', 'sentence_words'] as const;

let next = 0;
const row = (
  form: string,
  lemma: string,
  partOfSpeech: string,
  translation: string,
  example: string,
  exampleTranslation: string,
): GenerationContext => {
  next += 1;
  return {
    glossId: `gloss-${next}`,
    senseId: `sense-${next}`,
    variantId: `variant-${next}`,
    lexemeId: `lexeme-${next}`,
    form,
    lemma,
    partOfSpeech,
    translation,
    example,
    exampleTranslation,
    acceptedAnswers: [],
    answerForm: null,
    acceptedAt: null,
  };
};

/** Ten Italian items, a full session's batch, one or more of every task kind. */
const ROWS: { row: GenerationContext; task: Task }[] = [
  { task: 'meaning', row: row('parlo', 'parlare', 'verb', 'מדבר', 'Parlo con mia madre ogni giorno.', 'אני מדבר עם אמא שלי כל יום.') },
  { task: 'word', row: row('casa', 'casa', 'noun', 'בית', 'La nostra casa è vicino al mare.', 'הבית שלנו קרוב לים.') },
  { task: 'typed', row: row('sempre', 'sempre', 'adverb', 'תמיד', 'Ho sempre fame la sera.', 'אני תמיד רעב בערב.') },
  { task: 'gap', row: row('prenotare', 'prenotare', 'verb', 'להזמין', 'Voglio prenotare un tavolo per due.', 'אני רוצה להזמין שולחן לשניים.') },
  { task: 'sentence', row: row('pianta', 'pianta', 'noun', 'צמח', 'Questa pianta ha bisogno di luce.', 'הצמח הזה צריך אור.') },
  { task: 'translate', row: row('campo', 'campo', 'noun', 'שדה', 'Il contadino lavora nel campo.', 'האיכר עובד בשדה.') },
  // Phase 62 (spec D1): two gap and two sentence items, each writing a sentence from the learner's words.
  { task: 'sentence', row: row('bella', 'bello', 'adjective', 'יפה', 'Che bella giornata!', 'איזה יום יפה!') },
  { task: 'word', row: row('finestra', 'finestra', 'noun', 'חלון', 'Apri la finestra, per favore.', 'פתח את החלון, בבקשה.') },
  { task: 'gap', row: row('compro', 'comprare', 'verb', 'לקנות', 'Compro il pane ogni mattina.', 'אני קונה לחם כל בוקר.') },
  { task: 'translate', row: row('parla', 'parlare', 'verb', 'לדבר', 'Lei parla tre lingue.', 'היא מדברת בשלוש שפות.') },
];

/** Phase 59, 62. The learner's practised words, as the prompts are sent them. */
const LEARNER_WORDS = ['contadino:איכר', 'lavora:עובד', 'tre:שלוש', 'lingue:שפות', 'madre:אמא', 'casa:בית'].map((pair, index) => {
  const [word, meaning] = pair.split(':');
  return { key: `w${index + 1}`, glossId: `g-w${index + 1}`, word, meaning };
});

/** The card each row's context item is for, with --context: every kind the call
 *  answers, a target sentence, a Hebrew one and a sentence card's mark. */
const CONTEXT_TYPES: Record<Task, QuestionType> = {
  meaning: 'multiple_choice',
  word: 'reverse_choice',
  typed: 'typed_translation',
  gap: 'typed_meaning',
  sentence: 'cloze_typed',
  translate: 'sentence_translation',
};

type Args = { oversized: boolean; distractors: number | null; extra: number; context: boolean; check: boolean; required: boolean };

function parseArgs(argv: string[]): Args {
  const number = (flag: string): number | null => {
    const at = argv.indexOf(flag);
    if (at === -1) return null;
    const value = Number(argv[at + 1]);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} needs a positive integer`);
    return value;
  };
  return {
    oversized: argv.includes('--oversized'),
    distractors: number('--distractors'),
    extra: number('--extra') ?? 0,
    context: argv.includes('--context'),
    check: argv.includes('--check'),
    required: argv.includes('--required'),
  };
}

/** The schema actually sent: the repo's own, or a variant derived from it so it keeps tracking the repo's. */
function schemaFor(args: Args): { schema: ZodType; label: string } {
  if (!args.oversized && args.distractors === null && args.extra === 0) {
    return { schema: LlmDistractorsSchema, label: 'LlmDistractorsSchema as it stands' };
  }
  const shape: Record<string, ZodType> = { ...LlmDistractorsSchema.shape.items.element.shape };
  const notes: string[] = [];
  if (args.distractors !== null) {
    shape.distractors = z.array(z.string()).max(args.distractors);
    notes.push(`distractors capped at ${args.distractors}`);
  }
  for (let n = 1; n <= args.extra; n += 1) shape[`extra_${n}`] = z.string().optional();
  if (args.extra > 0) notes.push(`${args.extra} more optional string field(s)`);
  if (args.oversized) {
    shape.distractors = z.array(z.string()).max(20);
    for (const [name, type] of Object.entries(shape)) shape[`${name}_2`] = type;
    notes.push('distractors capped at 20, every field duplicated');
  }
  return { schema: z.object({ items: z.array(z.object(shape)).max(10) }), label: `variant: ${notes.join(', ')}` };
}

async function main(): Promise<number> {
  const gemini = loadGeminiConfig(process.env);
  if (gemini.baseUrl.includes('localhost') || gemini.baseUrl.includes('127.0.0.1')) {
    throw new Error(
      `GEMINI_BASE_URL points at ${gemini.baseUrl}. MockServer accepts any schema, so it measures nothing; ` +
        'unset it to use the real API.',
    );
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.context) return measureContext(gemini);
  if (args.check) return measureCheck(gemini, args.required);
  const { schema, label } = schemaFor(args);

  const recent: RecentSentences = new Map();
  const items = distractorItems(
    ROWS.map((entry) => entry.row),
    ROWS.map((entry) => entry.task),
    recent,
  );
  const prompt = buildDistractorPrompt({ items, from: 'it', to: 'he', others: [], learnerWords: LEARNER_WORDS });

  // The provider throws only `responded 400`; the reason is in the body, so a
  // wrapping fetch prints it. The body never carries the key (it travels in a header).
  let refusal = '';
  const loggingFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (!response.ok) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      refusal = (body as { error?: { message?: string } } | null)?.error?.message ?? '(no message in the body)';
    }
    return response;
  };
  const llm = createGeminiClient({
    fetch: loggingFetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: TIMEOUT_MS,
    // Phase 47 (spec D1, ruling R6): production's cap, and nothing recorded.
    thinkingBudget: SESSION_GENERATION_THINKING,
    onCall: async () => {},
    now: Date.now,
  });

  const sent = JSON.stringify(toGeminiSchema(schema));
  console.log(`model     ${gemini.model}`);
  console.log(`schema    ${label} (${sent.length} characters of responseSchema)`);
  console.log(`request   ${items.length} items: ${items.map((item) => item.task).join(' ')}`);

  const started = Date.now();
  let raw: string;
  try {
    raw = await llm({ system: prompt.system, user: prompt.user, schema, record: { kind: 'session_generation' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`after     ${Date.now() - started} ms`);
    // LlmUnavailable's message carries a prefix; the status is what ends it.
    if (/responded 400$/.test(message)) {
      console.log(`refused   ${message}: ${refusal}`);
      return 1;
    }
    console.log(`failed    ${message}${refusal ? `: ${refusal}` : ''} (inconclusive)`);
    return 2;
  }
  console.log(`after     ${Date.now() - started} ms`);
  console.log('accepted');
  console.log(`answer    ${raw.length} characters`);

  // The repo's own parser reads the answer, so a field it cannot read shows here.
  const answer = parseLlmDistractors(raw);
  if (!answer) {
    console.log(`parse     FAILED: ${raw.slice(0, 300)}`);
    return 3;
  }
  const filled = (field: string) =>
    answer.items.filter((item) => {
      const value = (item as Record<string, unknown>)[field];
      return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value !== '';
    }).length;
  console.log(`parse     ok, ${answer.items.length} items`);
  // Phase 62 (spec D1): what each sentence-writing item wrote, to read by eye.
  for (const item of items.filter((asked) => asked.task === 'gap' || asked.task === 'sentence' || asked.task === 'translate')) {
    const got = answer.items.find((found) => found.key === item.key);
    console.log(`  ${item.key} ${item.task.padEnd(9)} ${got?.sentence ?? '(none)'} | gap ${got?.gap ?? '-'} | ${got?.translation ?? '-'}${item.task === 'gap' ? ` | wrong ${got?.distractors.join(', ')}` : ''}`);
  }
  console.log(`distractors per item  ${answer.items.map((item) => item.distractors.length).join(' ')}`);
  for (const field of ['alternatives', 'sentence', 'gap', 'translation']) {
    console.log(`filled    ${field.padEnd(20)} ${filled(field)} of ${answer.items.length}`);
  }
  return 0;
}

/** Ruling R8. The context call at full size: one item per row, as prepareSession
 *  builds them, the sentence cards marking the saved example's Hebrew. Prints the
 *  wait, whether the schema was refused, and how each item would be kept. */
async function measureContext(gemini: ReturnType<typeof loadGeminiConfig>): Promise<number> {
  const items: ContextItem[] = ROWS.map(({ row, task }, index) =>
    contextItemFor({
      key: keyOf(index),
      type: CONTEXT_TYPES[task],
      row,
      alternatives: [],
      recent: [],
      sentence: { hebrew: row.exampleTranslation!, target: row.example!, word: row.form },
    })!,
  );
  // Phase 59 (spec D2): the translation cards' maps, with a learner's list to name.
  const learnerWords = ['contadino:איכר', 'lavora:עובד', 'tre:שלוש', 'lingue:שפות', 'madre:אמא', 'casa:בית'].map((pair, index) => {
    const [word, meaning] = pair.split(':');
    return { key: `w${index + 1}`, glossId: `g-${word}`, word, meaning };
  });
  const prompt = buildContextPrompt({ items, from: 'it', to: 'he', learnerWords });
  const llm = createGeminiClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    // Production's budget for this call (ruling R12): a wait past it is a fallback there.
    timeoutMs: CONTEXT_CALL_BUDGET_MS,
    onCall: async () => {},
    now: Date.now,
  });
  console.log(`model     ${gemini.model}`);
  console.log(`schema    LlmContextSchema (${JSON.stringify(toGeminiSchema(LlmContextSchema)).length} characters of responseSchema)`);
  console.log(`request   ${items.length} items: ${items.map((item) => item.task).join(' ')}`);
  const started = Date.now();
  let raw: string;
  try {
    raw = await llm({ ...prompt, record: { kind: 'context' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`after     ${Date.now() - started} ms`);
    if (/responded 400$/.test(message)) {
      console.log(`refused   ${message}`);
      return 1;
    }
    console.log(`failed    ${message} (inconclusive)`);
    return 2;
  }
  console.log(`after     ${Date.now() - started} ms`);
  console.log('accepted');
  const answer = parseLlmContext(raw);
  if (!answer) {
    console.log(`parse     FAILED: ${raw.slice(0, 300)}`);
    return 3;
  }
  console.log(`parse     ok, ${answer.items.length} items`);
  const found = new Map(answer.items.map((item) => [item.key, item]));
  for (const item of items) {
    const got = found.get(item.key);
    if (item.task === 'mark') {
      const mark = markFor(item, got);
      console.log(`${item.key} mark        ${got?.sentence_word ?? '(none)'} -> ${mark ? item.sentence.slice(mark.start, mark.end) : 'unmarked'}`);
      if (item.map) {
        const map = wordMapFor(item, got, mark, learnerWords, 'g-own');
        console.log(`${item.key} map         ${JSON.stringify(got?.sentence_words ?? null)}`);
        console.log(`${item.key} kept        ${map ? map.map((word) => `${item.sentence.slice(word.start, word.end)}=${word.text}${word.target ? '*' : ''}${word.glossId ? `(${word.glossId})` : ''}`).join(' ') : 'none'}`);
      }
      continue;
    }
    const outcome = resolveContext(item, got, { target: 'it', explanation: 'he' });
    const mark = outcome.context?.mark;
    console.log(
      `${item.key} ${item.task.padEnd(11)} ${outcome.dropped ? `DROPPED (${outcome.dropped})` : 'kept'}: ${got?.context ?? '(none)'}` +
        ` [${got?.context_word ?? ''}${mark && outcome.context ? ` -> ${outcome.context.text.slice(mark.start, mark.end)}` : ''}] = ${got?.context_translation ?? ''}`,
    );
  }
  for (const field of CONTEXT_FIELDS) {
    console.log(`filled    ${field.padEnd(20)} ${answer.items.filter((item) => (item as Record<string, unknown>)[field]).length} of ${answer.items.length}`);
  }
  return 0;
}

/** Spec D5. A full session's checks, sixteen of every kind, as prepareSession
 *  asks them for an English session with a board: choice cards (a multiple
 *  choice, a reversed card, a listen choice), the board's fifth-meaning
 *  candidates against each of its four words, a gap, target-language and Hebrew
 *  contexts, and sentence cards. Each has the answer a careful reader gives,
 *  printed beside the model's. */
const BOARD_CANDIDATES = ['ענן', 'גשם', 'רוח', 'סיר', 'מחבת', 'כוס'];
const SAW_READINGS = ['לנסר', 'מסור', 'ראה', 'לראות'];
const CHECKS: { item: CheckItem; expect: string }[] = [
  { item: { key: 'q1', task: 'choice', word: 'blow up', options: ['להרוס', 'לקפל', 'לשבור', 'להתפוצץ', 'לצבוע', 'לבשל'] }, expect: 'להרוס and להתפוצץ right' },
  { item: { key: 'q1c', task: 'meaning', sentence: 'The kids blew up twenty balloons.', word: 'blew up', candidates: ['לנפח', 'להתפוצץ', 'להגדיל', 'להתפרץ בכעס'] }, expect: 'לנפח' },
  { item: { key: 'q2', task: 'choice', word: 'מהר', options: ['quickly', 'fast', 'slowly', 'loudly', 'rarely', 'softly'] }, expect: 'quickly and fast right' },
  { item: { key: 'q2c', task: 'words', sentence: 'הוא רץ מהר מאוד לתחנה.', word: 'מהר' }, expect: 'fast, quickly' },
  { item: { key: 'q3c', task: 'words', sentence: 'אני רוצה להוריד את המשחק החדש הלילה.', word: 'להוריד' }, expect: 'download' },
  { item: { key: 'q4', task: 'choice', word: 'kettle', options: BOARD_CANDIDATES }, expect: 'none right (סיר at most)' },
  { item: { key: 'q5', task: 'choice', word: 'pillow', options: BOARD_CANDIDATES }, expect: 'none right' },
  { item: { key: 'q6', task: 'choice', word: 'ladder', options: BOARD_CANDIDATES }, expect: 'none right' },
  { item: { key: 'q7', task: 'choice', word: 'bucket', options: BOARD_CANDIDATES }, expect: 'none right' },
  { item: { key: 'q8', task: 'choice', word: 'pick up', options: ['להרים', 'לכתוב', 'לשיר', 'לרקוד', 'לבשל', 'לישון'] }, expect: 'להרים right' },
  { item: { key: 'q9', task: 'gap', sentence: 'She ___ the door and walked in.', options: ['unlocked', 'ate', 'slept', 'sang', 'cooked', 'painted'] }, expect: 'unlocked fits (painted too)' },
  { item: { key: 'q10', task: 'translate', sentence: 'בואו נשלב כוחות.' }, expect: 'join forces, not combine' },
  { item: { key: 'q11c', task: 'meaning', sentence: 'Please saw the plank in half.', word: 'saw', candidates: SAW_READINGS }, expect: 'לנסר' },
  { item: { key: 'q12c', task: 'meaning', sentence: 'I saw him at the station yesterday.', word: 'saw', candidates: SAW_READINGS }, expect: 'ראה or לראות' },
  { item: { key: 'q13c', task: 'words', sentence: 'תוריד את הווליום, בבקשה.', word: 'תוריד' }, expect: 'turn down, lower' },
  { item: { key: 'q14', task: 'translate', sentence: 'אני מקווה שהדברים ישתפרו בקרוב.' }, expect: 'improve or get better' },
];

/** Ruling R8. The checker call at full size, within production's budget for it. */
async function measureCheck(gemini: ReturnType<typeof loadGeminiConfig>, required: boolean): Promise<number> {
  const prompt = buildCheckPrompt(CHECKS.map((check) => check.item), 'en', 'he');
  const element = LlmCheckSchema.shape.items.element;
  const schema = required
    ? z.object({ items: z.array(z.object(Object.fromEntries(Object.entries(element.shape).map(([name, type]) => [name, type instanceof z.ZodOptional ? type.unwrap() : type])) as Record<string, ZodType>)) })
    : LlmCheckSchema;
  const llm = createGeminiClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: CHECKER_CALL_BUDGET_MS,
    onCall: async () => {},
    now: Date.now,
  });
  console.log(`model     ${gemini.model}`);
  console.log(`schema    LlmCheckSchema${required ? ', every field required' : ''} (${JSON.stringify(toGeminiSchema(schema)).length} characters of responseSchema)`);
  console.log(`request   ${CHECKS.length} items: ${CHECKS.map((check) => check.item.task).join(' ')}`);
  const started = Date.now();
  let raw: string;
  try {
    raw = await llm({ ...prompt, schema: schema as typeof LlmCheckSchema, record: { kind: 'checker' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`after     ${Date.now() - started} ms`);
    if (/responded 400$/.test(message)) {
      console.log(`refused   ${message}`);
      return 1;
    }
    console.log(`failed    ${message} (inconclusive)`);
    return 2;
  }
  console.log(`after     ${Date.now() - started} ms`);
  console.log('accepted');
  const answer = parseCheck(raw);
  const reading = answer ? readCheck(CHECKS.map((check) => check.item), answer) : null;
  if (!answer || !reading || reading.unjudged.size > 0) {
    console.log(`parse     FAILED: ${reading && reading.unjudged.size > 0 ? [...reading.unjudged.values()].join('; ') : raw.slice(0, 300)}`);
    return 3;
  }
  console.log(`parse     ok, ${answer.items.length} items`);
  for (const { item, expect } of CHECKS) {
    const finding = reading.byKey.get(item.key)!;
    const said = (() => {
      switch (finding.task) {
        case 'choice':
        case 'gap':
          return (item as { options: string[] }).options.filter((_, index) => finding.alsoRight[index]).join(', ') || '(none right)';
        case 'meaning':
          return finding.meaning || '(none)';
        case 'words':
          return finding.words.join(', ') || '(none)';
        case 'translate':
          return finding.translation || '(none)';
      }
    })();
    console.log(`${item.key.padEnd(4)} ${item.task.padEnd(9)} ${said}   [expected: ${expect}]`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
