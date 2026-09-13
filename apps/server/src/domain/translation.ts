import type {
  LlmReconciliation,
  LlmTranslation,
  PartOfSpeech,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';
import { LlmReconciliationSchema, LlmTranslationSchema } from '@lang-tutor/core/api/schemas';

/**
 * The pure core of translation: which way round the request is, what to ask the
 * model, and how to read the answer. No I/O, no clock, no randomness.
 *
 * ADR 0001 R3 forbids every cross-layer import here — anything reached by
 * climbing out of this directory — which shapes two things deliberately:
 * `parseLlmTranslation` returns `null` rather than throwing
 * `TranslationUnreadable` from `../errors`, and `TranslationPrompt` is declared
 * here rather than imported from `../services/llm`. It is structurally identical
 * to `LlmJsonRequest`; `services/translations.ts` is where the two meet and the
 * compiler checks them. Same arrangement as `db/transaction.ts` and
 * `services/transaction.ts`.
 */
export type TranslationPrompt = {
  system: string;
  user: string;
  schema: typeof LlmTranslationSchema;
};

/** The second call's prompt. Same shape, a different schema — `LlmClient` takes
 *  any `ZodType`, and `services/translations.ts` is where the two meet. */
export type RenderingPrompt = {
  system: string;
  user: string;
  schema: typeof LlmReconciliationSchema;
};

// The Hebrew block. Hebrew and Latin are disjoint in Unicode, so one character
// settles the direction — deterministic, free, and reproducible in a unit test,
// where asking the model would have been none of those things.
const HEBREW = /[֐-׿]/;

export function detectDirection(text: string): TranslationDirection {
  return HEBREW.test(text) ? 'he_en' : 'en_he';
}

/**
 * The model classifies `phrase` against `sentence`, because no token count can:
 * `break a leg` is three tokens and a phrase, `I read` is two and a sentence.
 * The single-token case is the one thing code can be certain of, so it wins
 * outright.
 */
export function resolveKind(text: string, modelKind: TranslationKind): TranslationKind {
  return /\s/.test(text.trim()) ? modelKind : 'word';
}

const LANGUAGE_NAMES = {
  en_he: { from: 'English', to: 'Hebrew' },
  he_en: { from: 'Hebrew', to: 'English' },
} as const;

export function buildPrompt(input: {
  text: string;
  direction: TranslationDirection;
}): TranslationPrompt {
  const { from, to } = LANGUAGE_NAMES[input.direction];

  // Three of these rules exist because of a specific failure mode, and each has
  // an eval case: an imperative fixed expression misclassified as a sentence, an
  // idiom translated word by word, and a sentence padded into a list of
  // alternatives behind a `more` button that should not appear. Phase 10 added
  // the nesting rules; phase 12 inverted the worked example, because "one entry
  // per headword" was itself the reason `booked` came back carrying the noun's
  // senses in the infinitive. An entry is now a lexeme — a headword AND a part
  // of speech — and the last rule is what makes the answer fit the form typed
  // rather than the headword it belongs to.
  const system = [
    `You translate from ${from} to ${to} for a Hebrew-speaking learner of English.`,
    'Return JSON only, matching the supplied schema.',
    'Classify the input as "word", "phrase" or "sentence".',
    'A fixed dictionary expression is a "phrase" even when it is grammatically imperative:',
    '"break a leg" is a phrase, not a sentence.',
    'Translate an idiom by its meaning, never word by word.',
    'Return one entry per headword the input could belong to, most likely reading first,',
    'at most 6. An inflected form belongs to its headword and carries the headword\'s',
    'senses: "running" is one entry whose lemma is "run".',
    'Return one entry per headword AND part of speech: "book" is two entries, one noun and',
    'one verb. An inflected form belongs to the entry whose part of speech it realises:',
    '"booked" is the verb entry only, never the noun; "books" is legitimately both.',
    'Within an entry, rank its own senses with the most common first, at most 5.',
    `Give each sense one short natural example sentence in ${from} together with its ${to}`,
    'translation, and a short snake_case sense_code naming the meaning',
    '(financial_institution as against river_bank).',
    `Translate into the grammatical form matching the input's: a past-tense input takes a`,
    'past-tense translation. A bare or "to"-marked English verb — "book", "to book" — is the',
    `base form and takes the ${to} infinitive: להזמין, never הזמין. Where ${to} offers several`,
    'forms for one category, use its dictionary citation form for that category; for Hebrew',
    'past tense that is third-person masculine singular. Build the example sentence around the',
    'input as typed, not around its headword.',
    // "citation form" reads to the model as "how a dictionary prints it", and a
    // printed Hebrew dictionary prints nikud. That cost a recording of סֵפֶר
    // where every consumer here — the wire, the quiz options, the eval's
    // substring matching — expects ספר. Say the script rule outright.
    'Write Hebrew in plain unvocalised script, with no nikud: ספר, never סֵפֶר.',
    'For a "sentence": return exactly one entry holding exactly one sense with the',
    'translation, and omit the example entirely — a sentence needs no example of itself.',
    'Its part_of_speech is required by the schema but meaningless for a sentence, and the',
    'server discards it along with the entry, which is never stored; answer "verb".',
    'If the input is not a word or expression in either language, return an empty entries',
    'array rather than inventing a translation.',
  ].join(' ');

  // The learner's text is untrusted and stays in its own part, never
  // concatenated into the instruction. Structured output is the real protection:
  // an injection cannot change the shape the client parses.
  return { system, user: input.text, schema: LlmTranslationSchema };
}

/**
 * Models emit fenced JSON even when asked not to. Stripping the fence is
 * tolerance for a formatting habit, not for a wrong shape — the schema still
 * decides whether the content is acceptable.
 */
function unfence(raw: string): string {
  const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : raw;
}

/**
 * Removes null-valued keys so `null` and absent mean the same thing. Under
 * OpenAI's strict structured output an optional field comes back as `null`
 * rather than missing, so a parser that tolerated only absence would break on a
 * provider swap — the exact coupling the `LlmClient` seam exists to prevent.
 */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, dropNulls(entry)]),
  );
}

/** `null` means unreadable. The caller decides what that costs — see
 *  services/translations.ts, which raises TranslationUnreadable. */
export function parseLlmTranslation(raw: string): LlmTranslation | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmTranslationSchema.safeParse(dropNulls(json));
  return result.success ? result.data : null;
}

/**
 * Makes the sentence contract true regardless of what the model returned. The
 * schema permits a sentence with three senses and a part of speech; the app's
 * contract does not, and the server is the last place that can enforce it.
 */
export function normalizeSenses(
  kind: TranslationKind,
  senses: TranslationSense[],
): TranslationSense[] {
  if (kind !== 'sentence') return senses;
  return senses.slice(0, 1).map((sense) => ({ translation: sense.translation }));
}

/** One stored sense as the reconciliation prompt needs it: a code and the gloss
 *  that names what it means. */
export type StoredSense = {
  senseCode: string;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

/**
 * The second call. It exists because `sense_code` is model-invented per call:
 * a lookup of `bank` names a sense river_bank and a later lookup of `banks`
 * names the same sense river_edge, so a string comparison would duplicate the
 * meaning silently. Deciding whether two glosses mean the same thing is a
 * judgement, so the model makes it.
 *
 * Pure, like buildPrompt — it takes the stored senses as input rather than
 * reaching for them, which is what keeps it unit-testable and eval-scorable.
 */
export function buildRenderingPrompt(input: {
  form: string;
  direction: TranslationDirection;
  lemma: string;
  partOfSpeech: PartOfSpeech;
  storedSenses: StoredSense[];
}): RenderingPrompt {
  const { from, to } = LANGUAGE_NAMES[input.direction];

  // Each stored sense as `code — gloss — example`, one per line. The gloss is
  // what the model matches on; the code is what it must give back unchanged
  // when it decides the meaning is the same one.
  const stored = input.storedSenses
    .map((sense) => {
      const example = sense.exampleSource ? ` — e.g. "${sense.exampleSource}"` : '';
      return `- ${sense.senseCode} — ${sense.translation}${example}`;
    })
    .join('\n');

  const system = [
    `You translate from ${from} to ${to} for a Hebrew-speaking learner of English.`,
    'Return JSON only, matching the supplied schema.',
    `The ${from} headword "${input.lemma}" (${input.partOfSpeech}) is already in this`,
    `dictionary with the senses below, each a sense_code and the ${to} gloss recorded for`,
    'it:',
    '',
    stored,
    '',
    `Render those senses for the form "${input.form}".`,
    'Return one item per stored sense, reusing its sense_code EXACTLY whenever the meaning',
    'is the same one — even where you would have named it differently. Use a new',
    'snake_case sense_code only for a reading the list above does not contain.',
    `Where "${input.form}" does not admit a stored sense at all, return that sense_code with`,
    'translation: null rather than forcing a translation.',
    `Translate into the grammatical form matching "${input.form}": a past-tense form takes a`,
    'past-tense translation. A bare or "to"-marked English verb — "book", "to book" — is the',
    `base form and takes the ${to} infinitive: להזמין, never הזמין. Where ${to} offers several`,
    'forms for one category, use its dictionary citation form for that category; for Hebrew',
    `past tense that is third-person masculine singular. Build each example sentence around`,
    `"${input.form}" as typed, not around the headword.`,
    // Same rule as the first call, for the same reason — see buildPrompt.
    'Write Hebrew in plain unvocalised script, with no nikud: ספר, never סֵפֶר.',
    `Rank the result for "${input.form}" itself, most common first — not in the order above,`,
    'which is another form\'s ranking.',
  ].join(' ');

  // The queried form is untrusted and stays in its own part, exactly as in
  // buildPrompt. It is also named in the instruction above, which is why the
  // schema — not the prose — is what the parse trusts.
  return { system, user: input.form, schema: LlmReconciliationSchema };
}

/**
 * Mirrors `parseLlmTranslation`, minus `dropNulls`.
 *
 * `translation: null` is load-bearing here — it is how the model says a form
 * does not admit a stored sense at all — so stripping nulls would turn that
 * answer into a malformed one. The schema is parsed against the raw JSON, and
 * an absent `example` is still absent rather than null because the model is
 * asked for the shape directly.
 */
export function parseLlmReconciliation(raw: string): LlmReconciliation | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmReconciliationSchema.safeParse(json);
  return result.success ? result.data : null;
}
