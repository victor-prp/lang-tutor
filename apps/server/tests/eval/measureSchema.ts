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
 *   --omit-context     drop the four context fields from the sent schema.
 *   --extra N          add N more optional string fields: the headroom left.
 *
 * The prompt is the production one. Only the user message gains an `also` block
 * that asks for the fields the prompt does not ask for yet, so the model fills
 * them and the answer is as long as a real one; the wording is a measurement's,
 * not the product's.
 *
 * Exit status: 0 accepted, 1 refused (a 400), 2 any other provider failure (the
 * measurement is then inconclusive), 3 accepted but the answer does not parse.
 */
import { z, type ZodType } from 'zod';

import { LlmDistractorsSchema } from '@lang-tutor/core/api/schemas';

import { loadGeminiConfig } from '../../src/config';
import {
  buildDistractorPrompt,
  distractorItems,
  parseLlmDistractors,
  type GenerationContext,
  type RecentSentences,
  type Task,
} from '../../src/domain/distractors';
import { createGeminiClient, toGeminiSchema } from '../../src/providers/gemini';

/** The session batch's production budget (composition.ts: sessionGenerationTimeoutMs). */
const TIMEOUT_MS = 300_000;

/** The four fields spec D6 and D8 add to an item. */
const CONTEXT_FIELDS = ['context', 'context_translation', 'context_word', 'sentence_word'] as const;

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
  { task: 'meaning', row: row('bella', 'bello', 'adjective', 'יפה', 'Che bella giornata!', 'איזה יום יפה!') },
  { task: 'word', row: row('finestra', 'finestra', 'noun', 'חלון', 'Apri la finestra, per favore.', 'פתח את החלון, בבקשה.') },
  { task: 'gap', row: row('compro', 'comprare', 'verb', 'לקנות', 'Compro il pane ogni mattina.', 'אני קונה לחם כל בוקר.') },
  { task: 'translate', row: row('parla', 'parlare', 'verb', 'לדבר', 'Lei parla tre lingue.', 'היא מדברת בשלוש שפות.') },
];

/** What the production prompt does not ask for yet (Tasks 5 and 6 write that wording). */
const ALSO = {
  wrong_answers: 'For a "meaning", "word" or "gap" item write six wrong answers in distractors instead of three.',
  context_for_meaning:
    'For a "meaning" item also write context: a short, natural everyday sentence in the learned language that uses the word in the meaning given by correct; context_word: the word exactly as it appears in context; context_translation: the whole sentence in natural Hebrew.',
  context_for_word_and_typed:
    'For a "word" or "typed" item also write context: a short, natural everyday Hebrew sentence that uses the meaning in correct; context_word: the Hebrew word exactly as it appears in context; context_translation: the whole sentence in the learned language.',
  sentence_word:
    'For a "sentence" or "translate" item also write sentence_word: the practised word exactly as it appears in the Hebrew sentence (translation for a "sentence" item, sentence for a "translate" item).',
};

type Args = { oversized: boolean; distractors: number | null; omitContext: boolean; extra: number };

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
    omitContext: argv.includes('--omit-context'),
    extra: number('--extra') ?? 0,
  };
}

/** The schema actually sent: the repo's own, or a variant derived from it so it keeps tracking the repo's. */
function schemaFor(args: Args): { schema: ZodType; label: string } {
  if (!args.oversized && args.distractors === null && !args.omitContext && args.extra === 0) {
    return { schema: LlmDistractorsSchema, label: 'LlmDistractorsSchema as it stands' };
  }
  const shape: Record<string, ZodType> = { ...LlmDistractorsSchema.shape.items.element.shape };
  const notes: string[] = [];
  if (args.omitContext) {
    for (const field of CONTEXT_FIELDS) delete shape[field];
    notes.push('without the context fields');
  }
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
  const { schema, label } = schemaFor(args);

  const recent: RecentSentences = new Map();
  const items = distractorItems(
    ROWS.map((entry) => entry.row),
    ROWS.map((entry) => entry.task),
    recent,
  );
  const prompt = buildDistractorPrompt({ items, from: 'it', to: 'he', others: [] });
  const user = JSON.stringify({ ...JSON.parse(prompt.user), also: ALSO });

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
  });

  const sent = JSON.stringify(toGeminiSchema(schema));
  console.log(`model     ${gemini.model}`);
  console.log(`schema    ${label} (${sent.length} characters of responseSchema)`);
  console.log(`request   ${items.length} items: ${items.map((item) => item.task).join(' ')}`);

  const started = Date.now();
  let raw: string;
  try {
    raw = await llm({ system: prompt.system, user, schema });
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
  console.log(`distractors per item  ${answer.items.map((item) => item.distractors.length).join(' ')}`);
  for (const field of ['alternatives', 'sentence', 'gap', 'translation', ...CONTEXT_FIELDS]) {
    console.log(`filled    ${field.padEnd(20)} ${filled(field)} of ${answer.items.length}`);
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
