import type {
  LlmReconciliation,
  LlmTranslation,
  PartOfSpeech,
  TranslationCorrection,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';
import { LlmReconciliationSchema, LlmTranslationSchema } from '@lang-tutor/core/api/schemas';

import { normalizeForm } from './dictionary';

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

/**
 * A form is usable as a dictionary key only if it contains something to look up.
 *
 * Written as a CONTENT test and not as "normalizes to the empty string", which
 * would fire on almost nothing: `normalizeForm` returns its input unchanged
 * whenever stripping a trailing sentence mark would empty it (phase 12's F4
 * branch), so `normalizeForm('???')` is `'???'`. Only a whitespace-only string —
 * which `.min(1)` barely admits — normalizes to `''` at all. Letter-or-digit
 * covers whitespace, punctuation, and any mixture of them.
 */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * The alternatives, tidied rather than rejected. Truncating is deliberate: the
 * alternative was failing a whole answer over a decorative field.
 *
 * **Two callers, which is why it is a named function.** The guards call it so the
 * response the model's own answer produces is right, and `persistCorrection`
 * calls it again on the way into the database, so the three-item cap is a
 * property of the WRITE rather than of one caller — `dict:restore` reaches the
 * repository without passing through `domain/` at all, exactly as `dictImport`
 * already does. Idempotent by construction: tidying an already-tidy list returns
 * it unchanged, so the second application costs nothing and the two callers
 * cannot disagree.
 *
 * `undefined` is a real input, not defensiveness: `LlmCorrectionSchema.alternatives`
 * is `.optional()` rather than `.default([])`, so a model that omits the key hands
 * this function an `undefined`, and turning it into `[]` here is what keeps a
 * missing decorative field from reaching the wire schema, which requires the array.
 */
export function tidyAlternatives(
  alternatives: string[] | undefined,
  context: { correctedForm: string; typedForm: string },
): string[] {
  // Seeded with both forms, so an alternative that merely repeats one of them is
  // removed by the same pass that removes a repeat of another alternative.
  // Case-insensitive, and the FIRST occurrence is the one kept, so the model's
  // ranking survives.
  const seen = new Set([context.correctedForm.toLowerCase(), context.typedForm.toLowerCase()]);
  const tidied: string[] = [];

  for (const raw of alternatives ?? []) {
    const form = normalizeForm(raw);
    if (!HAS_CONTENT.test(form)) continue;
    const key = form.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tidied.push(form);
    if (tidied.length === 3) break;
  }

  return tidied;
}

/** What the service needs from a parsed answer before it touches a database:
 *  which form the rest of the pipeline is about, what `kind` that form is, and
 *  the correction block to attach to the response — if any survived. */
export type ResolvedCorrection = {
  correction?: TranslationCorrection;
  effectiveForm: string;
  kind: TranslationKind;
};

/**
 * The four guards, the empty-entries clearing, the normalization of both forms
 * and `resolveKind` — one pure function, applied to the parsed answer before
 * phase 12's early return, so a dropped correction costs no database read and no
 * second model call.
 *
 * **`null` means the answer is unusable**, which is the fourth guard and the only
 * one that is not a drop. `domain/` cannot throw `TranslationUnreadable` — R3
 * forbids importing `../errors` — so the caller raises, the arrangement
 * `parseLlmTranslation` already uses.
 *
 * **The clearing runs before the effective form is computed, and that ordering is
 * the point.** `kind` is computed from `effectiveForm`, and phase 12's
 * empty-entries early return carries that `kind` — so a correction the response
 * declines to report would already have changed the answer by the time the early
 * return runs. A model answering `zxqwbtl` with `entries: []` and
 * `corrected_form: "zxq wbtl"` would otherwise return `kind: 'phrase'` for a
 * single-token input: no correction block, no rows written, and a `kind` that came
 * from a correction the response denies carrying.
 *
 * Two callers: `services/translations.ts` at step 4 of the flow, and the eval
 * harness's `askModel`, which is what lets that bucket score the `kind` the server
 * would actually have written rather than a copy of the logic.
 */
export function resolveCorrection(
  parsed: LlmTranslation,
  context: { typedForm: string; direction: TranslationDirection },
): ResolvedCorrection | null {
  // The kind the answer has BEFORE any substitution. It is what the drop paths
  // return, and it is what the sentence guard reads: `resolveKind` against the
  // typed form is the clamp the request already earns, so a single token the
  // model called a sentence is a `word` here and keeps its correction, while a
  // genuine multi-token sentence loses it.
  const typedKind = resolveKind(context.typedForm, parsed.kind);
  const uncorrected: ResolvedCorrection = {
    effectiveForm: context.typedForm,
    kind: typedKind,
  };

  // The fifth rule, deliberately not listed as a guard: it is a test on the
  // ENTRIES, not on the correction's content, and where it runs matters more than
  // what it does — see the ordering note above.
  if (!parsed.correction || parsed.entries.length === 0) return uncorrected;

  // Guard 3, first because it is the cheapest and scopes the whole feature:
  // detection is words and phrases. "I have a sore thruot" is out of scope.
  if (typedKind === 'sentence') return uncorrected;

  // Never the model's string as it arrived. What `normalizeForm` returns IS the
  // dictionary key, and phase 12 added trailing-punctuation stripping to it
  // precisely because the dev database held `book` with three senses and `book?`
  // with four. A model answering `corrected_form: "Throat."` would otherwise write
  // exactly that as a dict_variants.form and as a redirect target.
  const correctedForm = normalizeForm(parsed.correction.corrected_form);

  // Guard 1 — "did you mean throat? showing results for throat".
  if (correctedForm.toLowerCase() === context.typedForm.toLowerCase()) return uncorrected;
  // Guard 2 — see HAS_CONTENT.
  if (!HAS_CONTENT.test(correctedForm)) return uncorrected;
  // Guard 4 — the answer is unusable, not merely uncorrected. `direction` was
  // detected from the typed script before call 1 and is fixed for the request.
  if (detectDirection(correctedForm) !== context.direction) return null;

  return {
    correction: {
      corrected_form: correctedForm,
      alternatives: tidyAlternatives(parsed.correction.alternatives, {
        correctedForm,
        typedForm: context.typedForm,
      }),
    },
    effectiveForm: correctedForm,
    // Against the CORRECTED form, which is what makes `bokked` → `booked` a
    // `word` even when the model answered `phrase`. It is not the whole of the
    // job: the clamp fires only on a single token, so a multi-token corrected
    // form is the model's call and the fourth prompt rule is what secures it.
    kind: resolveKind(correctedForm, parsed.kind),
  };
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
    // Phase 12 follow-up, F2. The model lemmatises verb forms to the base verb every
    // time and wavers on participial adjectives, which put two lexemes in the
    // dictionary for one adjective — measured as `burnt` naming `burnt` and
    // `burned` naming `burn` on the same afternoon, so it is not a wrong rule
    // but the absence of one. Pinning to the base verb was rejected: it would
    // merge the active and passive participles, and "a charming man" is not
    // the same adjective as "I'm charmed".
    'A participial adjective is its own headword rather than the base verb, and its lemma is',
    'the participle spelled the regular way where a word has two: "burnt" and "burned" are',
    'both the adjective "burned", while "burning" is the separate adjective "burning".',
    'Within an entry, rank its own senses with the most common first, at most 5.',
    `Give each sense one short natural example sentence in ${from} together with its ${to}`,
    'translation, and a short snake_case sense_code naming the meaning',
    '(financial_institution as against river_bank).',
    // Phase 12 follow-up. Where two senses of one entry render to the same word in the
    // target language — Hebrew says מים for water-the-substance and
    // water-the-lake — the example is the ONLY thing that can tell the two
    // cards apart, and "The water was cold" fits a glass and a lake equally.
    // The illustration uses `spring`, which is in neither the seed nor the eval
    // set, so it cannot bias anything this repo measures. The illustration also
    // avoids `saw` and `see`, the only two expectations this instruction can
    // trip. An UNQUOTED matchText matches a regex over the whole request body,
    // and the system instruction is in that body; a QUOTED one (`"bank"`,
    // `"scan"`) matches only the learner's text, because the body is
    // JSON-encoded and the instruction's own quotes arrive escaped — measured,
    // not reasoned: a body whose instruction reads `Rule: "banks" is plural`
    // matches the expectation `banks` and does not match `"banks"`. Re-derive
    // the forbidden pair from the registered expectations before changing any
    // illustration word here or in any other rule. An earlier draft said "We saw
    // the spring" and made every `see` lookup in that bucket match the `saw`
    // expectation instead.
    'Choose each example so that it could not be read as any other sense of the same word.',
    'A sentence that merely contains the word is not enough — it must rule the other senses',
    'out. For "spring": "The spring in the mattress broke" rules out the season, while "I like',
    'the spring" rules out nothing.',
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
    // Phase 13. REPLACED, not supplemented. Left standing beside the correction
    // rules below it is a flat contradiction about exactly the input this phase
    // exists for: `thruot` is not a word in either language, so the old wording
    // demanded empty entries while the new one demands entries describing
    // `throat`. The added clause carries the whole difference.
    //
    // "in either language" is kept rather than narrowed to the source language,
    // and the rules below say it for the same reason: `direction` is detected
    // from the script and can be wrong, so a rule scoped to the detected source
    // would let a real English word typed under he_en be reported as a
    // misspelling of a Hebrew one.
    'If the input is not a word or expression in either language and no real word or',
    'expression was plausibly intended, return an empty entries array and omit `correction`,',
    'rather than inventing a translation.',
    // Phase 13, rule 1. The rule the whole feature turns on and the one most
    // likely to regress, because `lemma ≠ typed form` is true of an inflection
    // AND of a typo — which is precisely why detection cannot be a string
    // comparison and has to be asked for explicitly. `saws` is the obvious
    // illustration word and is FORBIDDEN: it is registered unquoted as a
    // MockServer matchText, and the system instruction is part of the body those
    // expectations match against. `running` and `booked` already appear above, so
    // they add no new exposure; `walks` and `went` are clear.
    'A correctly spelled inflected form is not a misspelling: "running", "booked", "walks"',
    'and "went" are real forms of real words — return them normally and omit `correction`.',
    // Phase 13, rule 2. `corrected_form` is a SURFACE form, never a lemma: a
    // learner typing `bokked` wants `booked`, whose lemma is `book`. Under phase
    // 10 the distinction was invisible; phase 12 made it load-bearing, because
    // `booked` renders הזמין and `book` renders להזמין on purpose.
    'When the input is not a word or expression in either language but one or more real ones',
    'were plausibly intended, set `correction.corrected_form` to the single most likely',
    'intended surface form — matching the grammatical form the learner appears to have typed,',
    'so `bokked` corrects to `booked` and not to `book` — and list up to three other plausible',
    'intended forms, ranked, in `correction.alternatives`. The `entries` then describe',
    '`corrected_form`.',
    // Phase 13, rule 3. Suspends, for this path only, the
    // "build the example sentence around the input as typed" rule above. Without
    // it the dictionary stores example sentences containing a misspelling —
    // permanently, since persistEntries writes exactly these examples.
    'When `correction` is present, build the example sentence around `corrected_form`, never',
    'around the input as typed.',
    // Phase 13, rule 4. The one a reader will think redundant, and the one with a
    // permanent consequence. `resolveKind` clamps a single token to `word` and
    // otherwise DEFERS to the model, so it cannot rule on a multi-token corrected
    // form; `kind` is then written onto dict_variants.kind for that form,
    // first-writer-wins, and read back by kindForForm on every later hit —
    // including the hit a learner who spells `break a leg` correctly gets.
    // Without this rule, one mistyped lookup freezes kind: 'word' on a real
    // phrase for the life of the dictionary. No server-side rule can repair it:
    // the mirror of the clamp does not exist, because a multi-token form can be a
    // phrase or a sentence and nothing in code can say which.
    //
    // The illustration reuses "break a leg", which the imperative-expression rule
    // above already names, so it adds no new exposure under the word constraint.
    'When `correction` is present, classify `corrected_form` rather than the input as typed:',
    '"breakaleg" is corrected to "break a leg", so its kind is "phrase" even though what was',
    'typed is a single token.',
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
    `Render those senses for the form "${input.form}" read as "${input.lemma}" used as a`,
    `${input.partOfSpeech}.`,
    'Return one item per stored sense, reusing its sense_code EXACTLY whenever the meaning',
    'is the same one — even where you would have named it differently. Use a new',
    `snake_case sense_code only for a reading that is itself "${input.lemma}" used as a`,
    `${input.partOfSpeech} and that the list above does not contain.`,
    // The phase 12 follow-up defect, and the reason the sentence above names the lexeme
    // twice. This call is scoped to ONE lexeme, but the form it renders may
    // belong to several: `pressing` is the verb `press` and, separately, the
    // adjective `pressing`. Asked only what readings the FORM has that the
    // stored list lacks, the model answered דחוף — truthfully, and onto the
    // verb, where it became a permanent row duplicating a meaning the adjective
    // entry of the same response already held.
    `"${input.form}" may also belong to other headwords or to other parts of speech. Those`,
    'are separate dictionary entries, answered by a separate call; never bring their',
    `readings in here. If "${input.form}" has a meaning that is not "${input.lemma}" used as`,
    `a ${input.partOfSpeech}, leave it out entirely.`,
    `Where "${input.form}" does not admit a stored sense at all, return that sense_code with`,
    'translation: null rather than forcing a translation.',
    // The same rule as the first call, for the same reason — see buildPrompt.
    // It belongs here too: this call writes examples for a form the first call
    // never saw, so without it a reconciled form reintroduces exactly the
    // ambiguity the first call now avoids.
    'Choose each example so that it could not be read as any other sense of the same word.',
    'A sentence that merely contains the word is not enough — it must rule the other senses',
    'out.',
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
