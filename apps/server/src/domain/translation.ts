import type {
  LlmTranslation,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';
import { LlmTranslationSchema } from '@lang-tutor/core/api/schemas';

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
  // the nesting rules, and `book` as a worked example — without it the nested
  // shape invites one sense per entry, which is the failure mirror-image to the
  // single-lemma shape it replaced.
  const system = [
    `You translate from ${from} to ${to} for a Hebrew-speaking learner of English.`,
    'Return JSON only, matching the supplied schema.',
    'Classify the input as "word", "phrase" or "sentence".',
    'A fixed dictionary expression is a "phrase" even when it is grammatically imperative:',
    '"break a leg" is a phrase, not a sentence.',
    'Translate an idiom by its meaning, never word by word.',
    'Return one entry per headword the input could belong to, most likely reading first,',
    'at most 3. An inflected form belongs to its headword and carries the headword\'s',
    'senses: "running" is one entry whose lemma is "run".',
    'Keep senses spanning parts of speech in ONE entry per headword: "book" is one entry',
    'whose senses are ספר (noun) and להזמין (verb) — never two entries for one lemma.',
    'Within an entry, rank its own senses with the most common first, at most 5.',
    `Give each sense a part_of_speech, one short natural example sentence in ${from}`,
    `together with its ${to} translation, and a short snake_case sense_code naming the`,
    'meaning (financial_institution as against river_bank).',
    'For a "sentence": return exactly one entry holding exactly one sense with the',
    'translation, and omit part_of_speech and example entirely — a sentence has no part',
    'of speech and needs no example of itself.',
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
