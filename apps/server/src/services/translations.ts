import type {
  LlmEntry,
  PartOfSpeech,
  TranslationDirection,
  TranslationKind,
  TranslationRequest,
  TranslationResponse,
  TranslationSense,
} from '@lang-tutor/core/api';

import {
  buildPrompt,
  buildRenderingPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmReconciliation,
  parseLlmTranslation,
  resolveCorrection,
  resolveKind,
  type StoredSense,
} from '../domain/translation';
import {
  flattenEntries,
  kindForForm,
  languagesFor,
  mergeEntries,
  normalizeForm,
  rowsToSenses,
  type SenseRow,
  type StaleLexeme,
} from '../domain/dictionary';
import { TranslationUnreadable } from '../errors';
import type { Logger } from '../logger';
import type { RepairedRendering } from '../repo/dictionary';
import type { LlmClient } from './llm';
import type { Transaction } from './transaction';

/**
 * The second model call, per entry that names a lexeme already in the
 * dictionary. It exists because `sense_code` is invented per call: a lookup of
 * `bank` names a sense river_bank and a later lookup of `banks` names the same
 * sense river_edge, so matching on the code alone stores the meaning twice —
 * and the dictionary has no TTL, so twice is forever.
 *
 * Module-private and not exported: it is one step of one use case, not a
 * primitive (ADR 0001 R9). Everything it decides that could be decided without
 * I/O lives in `domain/translation.ts` — the prompt and the parse — so what is
 * left here is the call and the bookkeeping.
 *
 * Throws rather than degrading. This deliberately differs from the failed-write
 * path in `translate`, which still answers 200: that one protects a correct
 * answer whose storage failed, this one prevents storing an answer known to be
 * wrong.
 */
async function reconcile(input: {
  llm: LlmClient;
  form: string;
  direction: TranslationDirection;
  entries: LlmEntry[];
  stored: StoredSense[][];
  logger: Logger;
}): Promise<LlmEntry[]> {
  let reused = 0;
  let newlyNamed = 0;
  let reconciledEntries = 0;

  const out = await Promise.all(
    input.entries.map(async (entry, index) => {
      const storedSenses = input.stored[index];
      // A lexeme nobody has stored has nothing to reconcile against: its codes
      // are new by construction, and a second call would only invite the model
      // to rename what it just named.
      if (storedSenses.length === 0) return entry;

      const raw = await input.llm(
        buildRenderingPrompt({
          form: input.form,
          direction: input.direction,
          lemma: entry.lemma,
          partOfSpeech: entry.part_of_speech,
          storedSenses,
        }),
      );

      const parsed = parseLlmReconciliation(raw);
      if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));

      reconciledEntries += 1;
      const known = new Set(storedSenses.map((sense) => sense.senseCode));
      const seen = new Set<string>();
      const senses: LlmEntry['senses'] = [];

      for (const rendering of parsed.senses) {
        // `translation: null` is the model saying this form does not admit that
        // sense at all — adjectival `booked` has no record-a-charge reading — so
        // the sense is simply absent for this form rather than forced.
        if (rendering.translation === null) continue;
        // Two renderings sharing a code resolve to one sense id, so they would
        // become two rows with the same (variant_id, sense_id,
        // user_language_code): a primary-key collision that DO NOTHING swallows,
        // leaving a hole in the rank sequence that
        // UNIQUE(variant_id, user_language_code, rank) then rejects. Keep the
        // first; the ranks are re-sequenced below, which is what keeps them
        // contiguous.
        if (seen.has(rendering.sense_code)) continue;
        seen.add(rendering.sense_code);

        if (known.has(rendering.sense_code)) reused += 1;
        else newlyNamed += 1;

        senses.push({
          sense_code: rendering.sense_code,
          translation: rendering.translation,
          ...(rendering.example ? { example: rendering.example } : {}),
        });
      }

      // An answer that reconciled to nothing at all is not an answer. Falling
      // back to call 1's entry here would write exactly the un-reconciled codes
      // this call exists to prevent, so it fails instead.
      if (senses.length === 0) {
        throw new TranslationUnreadable(
          `reconciliation returned no usable sense for ${entry.lemma} (${entry.part_of_speech})`,
        );
      }

      return { ...entry, senses };
    }),
  );

  input.logger.info({
    event: 'dict_reconciled',
    entry_count: reconciledEntries,
    reused,
    newly_named: newlyNamed,
  });

  return out;
}

/**
 * Re-render one form for every lexeme of it that has learned a sense since the
 * form was last written. Reuses `buildRenderingPrompt` unchanged.
 *
 * Throws on an unreadable answer, exactly like `reconcile` — but the CALLER
 * treats the throw differently: `reconcile` fails the lookup, this one is
 * caught and the stored answer served, because a failure here writes nothing.
 */
async function repairForm({
  llm,
  transaction,
  form,
  direction,
  stale,
  source,
  target,
}: {
  llm: LlmClient;
  transaction: Transaction;
  form: string;
  direction: TranslationDirection;
  stale: StaleLexeme[];
  source: string;
  target: string;
}): Promise<SenseRow[]> {
  // ONE transaction for every stale lexeme's senses, not one each. A
  // transaction per lexeme inside the Promise.all below would open N pooled
  // connections to do N tiny reads that could share one, and serialise nothing
  // useful — the parallelism that matters is the model calls, which come after.
  //
  // **The version is read here, beside the senses it belongs to, and BEFORE
  // them.** It is what the write below stamps onto the variant, and it has to
  // describe the sense list these renderings were derived from — not whatever
  // the lexeme has reached by the time a 5-15 second model call returns. Read
  // the other way round (senses, then version) a concurrent lookup could add a
  // sense between the two statements — each statement takes its own snapshot
  // under READ COMMITTED — and this form would be stamped level against a
  // version it never rendered, leaving the new sense invisible to it forever.
  // Version-first can only UNDER-stamp, which costs one extra repair.
  //
  // `transaction` is destructured and called bare, never read off a `deps` or
  // `input` object — the same discipline `createTranslationService` documents
  // for itself — because R8's lint check scans this tree for any other
  // dotted call site of the primitive.
  const storedPerLexeme = await transaction((repos) =>
    Promise.all(
      stale.map(async (lexeme) => {
        const senseVersion = await repos.dict.findSenseVersion({ lexemeId: lexeme.lexemeId });
        const senses = await repos.dict.findSensesByLexeme({
          lemma: lexeme.lemma,
          partOfSpeech: lexeme.partOfSpeech,
          languageCode: source,
          userLanguageCode: target,
        });
        return { senseVersion, senses };
      }),
    ),
  );

  const rendered = await Promise.all(
    stale.map(async (lexeme, index) => {
      const { senseVersion, senses: stored } = storedPerLexeme[index];

      const raw = await llm(
        buildRenderingPrompt({
          form,
          direction,
          lemma: lexeme.lemma,
          partOfSpeech: lexeme.partOfSpeech as PartOfSpeech,
          storedSenses: stored,
        }),
      );

      const parsed = parseLlmReconciliation(raw);
      if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));

      // Same three filters as `reconcile`, and for the same reasons: a null
      // translation is the form declining the sense; a repeated sense_code
      // would collide on the primary key; an unknown code names no stored
      // sense, and a repair may not invent one — that is what a MISS is for.
      const idByCode = new Map(stored.map((sense) => [sense.senseCode, sense.senseId]));
      const seen = new Set<string>();
      const senses: RepairedRendering[] = [];
      for (const rendering of parsed.senses) {
        if (rendering.translation === null) continue;
        if (seen.has(rendering.sense_code)) continue;
        if (!idByCode.has(rendering.sense_code)) continue;
        seen.add(rendering.sense_code);
        senses.push({
          senseId: idByCode.get(rendering.sense_code)!,
          // Re-sequenced from 0 and contiguous, never the model's index:
          // UNIQUE(variant_id, user_language_code, rank) rejects a hole.
          rank: senses.length,
          translation: rendering.translation,
          exampleSource: rendering.example?.source ?? null,
          exampleTarget: rendering.example?.target ?? null,
        });
      }

      if (senses.length === 0) {
        throw new TranslationUnreadable(
          `repair returned no usable sense for ${lexeme.lemma} (${lexeme.partOfSpeech})`,
        );
      }
      return { lexeme, senseVersion, senses };
    }),
  );

  // ONE write transaction for every stale lexeme of this form, ending in the
  // re-read — the same shape `persistEntries` uses, and what keeps the answer
  // identical to what the next lookup would produce.
  return transaction(async (repos) => {
    for (const { lexeme, senseVersion, senses } of rendered) {
      await repos.dict.repairVariantRenderings({
        variantId: lexeme.variantId,
        userLanguageCode: target,
        // The version read above, before the model call — never re-read here.
        senseVersion,
        senses,
      });
    }
    return repos.dict.findSensesByForm({
      form,
      languageCode: source,
      userLanguageCode: target,
    });
  });
}

/** What one form resolves to. `rows` travels with the answer because the hit log
 *  counts distinct lexemes, and only the CALLER logs the hit. */
type ServedForm = {
  kind: TranslationKind;
  senses: TranslationSense[];
  rows: SenseRow[];
};

/**
 * Resolve one form to an answer: read its rows beside its stale lexemes, repair
 * it where a lexeme is ahead, and answer from the rows actually served. `null` is
 * a MISS.
 *
 * This is phase 12's F5 hit path, lifted out of `translate` and given a parameter.
 * It is not new behaviour and not new machinery — naming it is what lets a
 * redirect reach the SAME path rather than a parallel one. Steps 1, 3 and 5b of
 * the flow all call it, with `form`, with a stored redirect's target, and with the
 * corrected form; "byte-identical to typing the correct spelling" is then the same
 * code path called twice rather than a hope about two staying in step.
 *
 * Module-private, like `reconcile` and `repairForm` above: one step of one use
 * case, not a primitive (ADR 0001 R9).
 *
 * **The repair events are logged HERE and the hit is NOT.** `dict_repaired` and
 * `dict_repair_failed` describe the repair whichever path reached it. The hit
 * belongs to the caller, which is the only place that knows whether it was a cache
 * hit or a redirect hit — and the ratio between those two is precisely what
 * `dict_redirect_hit` exists to show. Extracted with the hit log still inside,
 * every redirect hit would be counted as a cache hit as well.
 *
 * **Its own read transaction**, which is exactly what makes it reusable, and the
 * reason step 2's redirect lookup is NOT folded into it: that would mean passing a
 * redirect lookup through a function that knows nothing about redirects. R8 permits
 * these reads — each precedes third-party I/O.
 */
async function serveForm({
  llm,
  transaction,
  form,
  direction,
  source,
  target,
  logger,
}: {
  llm: LlmClient;
  transaction: Transaction;
  form: string;
  direction: TranslationDirection;
  source: string;
  target: string;
  logger: Logger;
}): Promise<ServedForm | null> {
  const { rows, stale } = await transaction(async (repos) => ({
    rows: await repos.dict.findSensesByForm({
      form,
      languageCode: source,
      userLanguageCode: target,
    }),
    stale: await repos.dict.findStaleLexemesByForm({ form, languageCode: source }),
  }));

  // Checked FIRST: a variant with no renderings in this target language is a
  // MISS, not a repair, even if its lexeme is ahead. It has never been looked up.
  if (rows.length === 0) return null;

  let answerRows = rows;
  if (stale.length > 0) {
    // The repair reuses buildRenderingPrompt verbatim: "here is everything this
    // lexeme knows, render it for THIS form and rank it for THIS form" is exactly
    // what a repair needs, and that prompt is eval-scored.
    try {
      answerRows = await repairForm({ llm, transaction, form, direction, stale, source, target });
      // Counts and direction, like every other event in this file. The learner's
      // query text stays out of the log.
      logger.info({ event: 'dict_repaired', direction, lexeme_count: stale.length });
    } catch (error) {
      // Deliberately NOT the fail-closed path. A failed repair writes nothing, so
      // the stored rows stand — correct when written, merely incomplete. Failing
      // the request would deny a learner an answer the dictionary already holds,
      // to protect them from an answer that is not wrong.
      logger.error('dict_repair_failed', error);
      answerRows = rows;
    }
  }

  // BOTH fields off the rows actually served, so a repair re-ranks the answer it
  // returns. `kind` is read, never guessed: it is written by the persisting call
  // onto the entry_rank 0 variant and read back by `kindForForm`, so a hit answers
  // with what was actually stored rather than a re-derived guess that can disagree.
  return { kind: kindForForm(answerRows), senses: rowsToSenses(answerRows), rows: answerRows };
}

/**
 * One use case: translate a word, phrase or sentence, reusing what the
 * dictionary already holds.
 *
 * **Two transactions, not one.** ADR 0001 R8 is amended in this phase to say a
 * use case opens at most one *write* transaction, and a read preceding
 * third-party I/O may be its own. Holding one open across the provider call
 * was rejected outright: ten seconds of an idle pooled connection per lookup,
 * one per concurrent learner. The two race harmlessly, because the write is
 * idempotent against UNIQUE(language_code, lemma) and UNIQUE(lexeme_id, form).
 *
 * Note the calls below are written as bare `transaction(...)`, destructured
 * from the parameter list, never read off a `deps` object: R8's lint check
 * scans this tree for any other call site of the primitive.
 */
export function createTranslationService({
  llm,
  transaction,
  logger,
}: {
  llm: LlmClient;
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    translate: async (input: TranslationRequest): Promise<TranslationResponse> => {
      // The schema already trimmed this, but the service must not depend on the
      // order validators ran in.
      const text = input.text.trim();
      const direction = input.direction ?? detectDirection(text);
      const { source, target } = languagesFor(direction);
      const form = normalizeForm(text);

      // Step 1 of the flow. The hot path: a correctly spelled word resolves here
      // exactly as it does today, repair included, and pays nothing for this phase.
      const direct = await serveForm({ llm, transaction, form, direction, source, target, logger });
      if (direct) {
        logger.info({
          event: 'dict_cache_hit',
          direction,
          term_count: new Set(direct.rows.map((r) => r.lexemeId)).size,
          sense_count: direct.senses.length,
        });
        return { text, direction, kind: direct.kind, senses: direct.senses };
      }

      // Step 2. One indexed lookup, its own read — R8 permits it, and it is
      // reached ONLY when the typed form has no rows, a path that otherwise costs
      // a provider call measured in seconds.
      //
      // NOT folded into `serveForm`: that function owns its own read transaction,
      // which is exactly what makes it reusable, and folding this in would mean
      // passing a redirect lookup through a function that knows nothing about
      // redirects.
      const redirect = await transaction((repos) =>
        repos.dict.findCorrectionByForm({ form, languageCode: source }),
      );

      if (redirect) {
        // Step 3 is step 1 with a different argument, and that is the whole of the
        // fix. A redirect hit is byte-identical to typing the correct spelling
        // because the SAME function produces both, staleness probe and repair
        // included. The correction block is attached AFTER serveForm returns and
        // changes neither field it produced.
        const served = await serveForm({
          llm,
          transaction,
          form: redirect.correctedForm,
          direction,
          source,
          target,
          logger,
        });
        if (served) {
          logger.info({
            event: 'dict_redirect_hit',
            direction,
            alternative_count: redirect.alternatives.length,
          });
          return {
            text,
            direction,
            kind: served.kind,
            senses: served.senses,
            correction: {
              corrected_form: redirect.correctedForm,
              alternatives: redirect.alternatives,
            },
          };
        }
        // A miss falls through to the model with the redirect DISCARDED. It is
        // deliberately not reused to rewrite the query: see Task 9's
        // "the model declines" note.
      }

      const raw = await llm(buildPrompt({ text, direction }));

      // An empty string is the contract's "no content" — a safety block, or a
      // candidate with no text. The input was refused; nothing is broken, and
      // nothing is written.
      if (raw === '') {
        logger.info({ event: 'translation_no_content', direction });
        return { text, direction, kind: resolveKind(text, 'word'), senses: [] };
      }

      const parsed = parseLlmTranslation(raw);
      // `domain/` cannot throw this itself: R3 forbids it importing ../errors.
      if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));

      // Step 4. One call, in domain/: the four guards, the empty-entries clearing,
      // both forms normalized and tidied, the effective form, and resolveKind
      // against that form. `null` means the answer cannot be used at all — the
      // fourth guard — and costs the same as an answer that failed to parse.
      const resolved = resolveCorrection(parsed, { typedForm: form, direction });
      if (!resolved) throw new TranslationUnreadable(raw.slice(0, 200));

      // Step 5. `correction` is the MODEL's, never the redirect step 2 may have
      // found: a model that declined to correct is answered on its own terms,
      // because its examples were built around the input as typed and filing them
      // under the correct spelling would be worse than a variant for the typo.
      const { correction, effectiveForm, kind } = resolved;

      // Step 5b — the corrected-form probe, only when a correction is present.
      //
      // The SAME function steps 1 and 3 call, repair included. Once the backfill
      // lands this is the ordinary corrected miss: corrections resolve to common
      // words, and common words already have rows. Without it, step 7 pays a
      // reconciliation call whose result the write discards (every insert in
      // persistEntries is DO NOTHING for a form that already has renderings), and
      // step 8 runs persistEntries on a form that already has rows — a path phase
      // 12's live flow never takes, because a hit returns at step 1 first. If call
      // 1 ranks the entries differently from the stored variant, the variant insert
      // collides on dict_variants_form_entry_rank_key — the safety net, which must
      // raise — the catch answers 200, and the redirect is rolled back with the
      // write. Two calls and a failed write on every lookup of that typo, forever.
      if (correction) {
        const probe = await serveForm({
          llm,
          transaction,
          form: effectiveForm,
          direction,
          source,
          target,
          logger,
        });

        if (probe) {
          // A SECOND, INDEPENDENT write: the probe may already have committed the
          // repair's transaction inside serveForm. Each is correct alone, each is
          // idempotent, and a failure between them leaves a correct dictionary and
          // one more provider call — ADR 0001 R8, fourth amendment. Contrast steps
          // 8 and 9, which are dependent and share one transaction.
          await transaction((repos) =>
            repos.dict.persistCorrection({
              typedForm: form,
              correctedForm: correction.corrected_form,
              alternatives: correction.alternatives,
              languageCode: source,
            }),
          );
          logger.info({
            event: 'dict_corrected',
            direction,
            alternative_count: correction.alternatives.length,
          });
          // No call 2 and no persistEntries: the target already holds its own
          // renderings.
          return { text, direction, kind: probe.kind, senses: probe.senses, correction };
        }

        // The chain. Made ONLY when the probe missed. Without it, step 8 would
        // write a dict_variants row for a string this very table records as not a
        // word — which then shadows that string's own redirect forever by the
        // "correct spellings win over redirects" rule: this phase's central defect
        // arriving by its own machinery.
        const hop = await transaction((repos) =>
          repos.dict.findCorrectionByForm({ form: effectiveForm, languageCode: source }),
        );
        if (hop) {
          const hopped = await serveForm({
            llm,
            transaction,
            form: hop.correctedForm,
            direction,
            source,
            target,
            logger,
          });
          // ONE hop, no further: a chain whose second target has no rows fails the
          // lookup rather than reading on, so the number of reads a lookup makes
          // never depends on data. It needs a chain AND a truncated dictionary.
          if (!hopped) throw new TranslationUnreadable(raw.slice(0, 200));

          const hopCorrection = {
            corrected_form: hop.correctedForm,
            alternatives: hop.alternatives,
          };
          await transaction((repos) =>
            repos.dict.persistCorrection({
              typedForm: form,
              // Straight to the hop's target, never to the typo the model named.
              correctedForm: hop.correctedForm,
              alternatives: hop.alternatives,
              languageCode: source,
            }),
          );
          logger.info({
            event: 'dict_corrected',
            direction,
            alternative_count: hop.alternatives.length,
          });
          // The model's entries described the intermediate typo. Discarded unwritten.
          return {
            text,
            direction,
            kind: hopped.kind,
            senses: hopped.senses,
            correction: hopCorrection,
          };
        }
      }

      let entries = mergeEntries(parsed.entries);
      let flattened = normalizeSenses(kind, flattenEntries(entries));

      // A sentence is not a vocabulary item, and caching "no translation" would
      // freeze a transient answer into a permanent dictionary. Both keep
      // costing on every repeat, deliberately.
      //
      // The reconciliation branch below sits AFTER this guard, not straight
      // after mergeEntries: a sentence is never written to the dictionary, so
      // reconciling one would spend a database round trip and possibly a second
      // model call on an answer that is then discarded.
      if (kind === 'sentence' || entries.length === 0) {
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        return { text, direction, kind, senses: flattened };
      }

      // Two independent calls name the same sense differently — `bank` returns
      // river_bank where `banks` returns river_edge — so matching on sense_code
      // alone would silently duplicate a meaning. Where a lexeme already has
      // senses, a second, smaller call reconciles by meaning instead. R8 permits
      // this read: it precedes third-party I/O and opens no write.
      const stored = await transaction((repos) =>
        Promise.all(
          entries.map((entry) =>
            repos.dict.findSensesByLexeme({
              lemma: entry.lemma,
              partOfSpeech: entry.part_of_speech,
              languageCode: source,
              userLanguageCode: target,
            }),
          ),
        ),
      );

      if (stored.some((senses) => senses.length > 0)) {
        // A failure here is NOT degraded into a partial write. The dictionary
        // has no TTL, so a known-wrong row is permanent while a failed request
        // costs the learner one retry. This deliberately differs from the
        // failed-write path below, which protects a correct answer whose
        // storage failed.
        entries = await reconcile({ llm, form: effectiveForm, direction, entries, stored, logger });
        // Both return paths below read `flattened`; a stale one would serve the
        // un-reconciled renderings on the failed-write path only.
        flattened = normalizeSenses(kind, flattenEntries(entries));
      }

      try {
        const { written, senses } = await transaction(async (repos) => {
          const result = await repos.dict.persistEntries({
            form: effectiveForm,
            languageCode: source,
            userLanguageCode: target,
            kind,
            entries,
          });
          // Step 9, in the SAME transaction as step 8. These two are DEPENDENT —
          // a redirect must not point at a form with no rows — which is what makes
          // phase 12's fail-closed rule cover this phase for free: a failed
          // reconciliation call writes no entries AND no redirect. (Contrast the
          // probe at step 5b, where a repair and a redirect are independent and
          // idempotent and may be two transactions; ADR 0001 R8, fourth amendment.)
          if (correction) {
            await repos.dict.persistCorrection({
              typedForm: form,
              correctedForm: correction.corrected_form,
              alternatives: correction.alternatives,
              languageCode: source,
            });
          }
          return result;
        });
        logger.info({
          event: 'dict_persisted',
          entry_count: written.length,
          lexemes_created: written.filter((entry) => entry.created).length,
        });
        if (correction) {
          logger.info({
            event: 'dict_corrected',
            direction,
            alternative_count: correction.alternatives.length,
          });
        }
        logger.info({ event: 'translated', direction, kind, sense_count: senses.length });
        return { text, direction, kind, senses, ...(correction ? { correction } : {}) };
      } catch (error) {
        // A failed write must not lose a translation the learner already paid
        // for. A broken persistence path shows up as this log line and as every
        // lookup costing a provider call — not as a 502 on a request the model
        // answered.
        logger.error('dict_persist_failed', error);
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        // The correction block is still attached: it describes the MODEL's answer,
        // which is true whether or not storage succeeded — the same reasoning that
        // keeps this path answering 200 with the senses the learner already paid
        // for. Only the redirect ROW is lost, and the next lookup writes it.
        return { text, direction, kind, senses: flattened, ...(correction ? { correction } : {}) };
      }
    },
  };
}

export type TranslationService = ReturnType<typeof createTranslationService>;
