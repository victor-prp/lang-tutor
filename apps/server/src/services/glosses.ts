import { normaliseGloss } from '@lang-tutor/core/domain';

import { buildGlossMergePrompt, mutualPairs, parseGlossMerge } from '../domain/glossMerge';
import { MergeGlossesPayloadSchema } from '../domain/jobs';
import type { LanguageCode } from '../domain/languages';
import { LlmUnavailable } from '../errors';
import type { Logger } from '../logger';
import type { MergeCounts, MergeWork } from '../repo/glosses';
import type { LlmClient } from './llm';
import type { Transaction } from './transaction';

/** The `gloss_merged` log line (spec D19): one shape for the job and the tool. */
function glossMerged(input: { lexemeId: string; userLanguageCode: string; survivorId: string; otherId: string; counts: MergeCounts }) {
  return {
    event: 'gloss_merged',
    lexeme_id: input.lexemeId,
    user_language_code: input.userLanguageCode,
    survivor_id: input.survivorId,
    merged_id: input.otherId,
    entries_moved: input.counts.entriesMoved,
    entries_folded: input.counts.entriesFolded,
    snapshots: input.counts.snapshots,
    questions: input.counts.questions,
    memberships: input.counts.memberships,
  };
}

export type PlannedMerge = {
  lexemeId: string;
  userLanguageCode: string;
  lemma: string;
  survivorId: string;
  survivorKey: string;
  otherId: string;
  otherKey: string;
  tier: 1 | 2;
};
export type MergePlan = {
  merges: PlannedMerge[];
  definitions: { senseId: string; definition: string }[];
  suggestions: { lemma: string; keys: [string, string] }[];
  /** Headwords (one lexeme in one language each) whose model call failed or
   *  answered unreadably: logged, left out of tier 2, and asked again next run. */
  skipped: number;
};

/** What planMerges reports while tier 2 runs, for the CLI to print (ADR 0001
 *  R7 keeps `console` out of a service): how many headwords it will ask, before
 *  the first call, then each headword once its call is done. */
export type MergeProgress =
  | { kind: 'asking'; headwords: number }
  | {
      kind: 'asked';
      done: number;
      of: number;
      lemma: string;
      partOfSpeech: string;
      userLanguageCode: string;
      merges: number;
      definitions: number;
      skipped: boolean;
    };

/** Spec D7's tier 2 selection: a headword with more than one live gloss, whose
 *  answer also fills its senses' missing definitions; with `definitions`, also
 *  a headword one of whose senses has no definition. */
function asksModel(item: MergeWork, definitions: boolean): boolean {
  return item.glosses.length >= 2 || (definitions && item.senses.some((sense) => sense.definition === null));
}

/**
 * Phase 31 (spec D7). The gloss use cases that are not a lookup: the merge job,
 * and the by-hand tool's plan and apply. A merge runs here, outside the lookup,
 * in a transaction of its own under the lexeme's lock; the lookup only ever asks
 * for one. `llm` is the tool's model tier: createGlossTools passes one when the
 * CLI asks for tier 2 and null otherwise, and the server's service, which
 * nothing asks for a plan, is handed null.
 */
export function createGlossService({
  transaction,
  logger,
  llm,
}: {
  transaction: Transaction;
  logger: Logger;
  llm: LlmClient | null;
}) {
  return {
    /** The merge-glosses job: every pair of one lexeme and language whose lemma
     *  form names another gloss's key, merged. Idempotent, so a retry is safe. */
    mergeLexeme: async (data: unknown): Promise<void> => {
      const { lexeme_id: lexemeId, user_language_code: userLanguageCode } = MergeGlossesPayloadSchema.parse(data);
      const merged = await transaction(async ({ dict, gloss }) => {
        await dict.lockLexemes([lexemeId]);
        const done: { otherId: string; survivorId: string; counts: MergeCounts }[] = [];
        for (const pair of await gloss.findMergeCandidates({ lexemeId, userLanguageCode })) {
          const counts = await gloss.mergeGlosses(pair);
          if (counts) done.push({ ...pair, counts });
        }
        return done;
      });
      for (const { otherId, survivorId, counts } of merged) {
        logger.info(glossMerged({ lexemeId, userLanguageCode, survivorId, otherId, counts }));
      }
    },

    /**
     * Spec D7, the by-hand tool. Tier 1 is the job's signal over the whole
     * dictionary. Tier 2 (`model`) asks the model, once per headword (a lexeme
     * in one learner language) with more than one live gloss, which of its
     * target words are forms of one word, and fills those headwords' missing
     * definitions on the way. `definitions` extends tier 2 to every headword
     * with a sense that has no definition, which after phase 31's deploy is
     * nearly every headword, so it is asked for by name. Mutual-alternative
     * pairs are listed as suggestions and never merged. Writes nothing.
     *
     * The model is called outside any transaction (ADR 0001 R8), after tier 1,
     * and `onProgress` hears how many headwords tier 2 will ask before the
     * first call, then each headword as its call ends. A headword whose call
     * fails (LlmUnavailable) or answers unreadably is logged and skipped, and
     * the rest are still planned: one call in thousands must not cost the run.
     * Any other error is a bug, and stops it.
     */
    planMerges: async ({
      model,
      definitions,
      onProgress,
    }: {
      model: boolean;
      definitions: boolean;
      onProgress: (progress: MergeProgress) => void;
    }): Promise<MergePlan> => {
      // A tier 2 request answered with tier 1 alone would print as a full plan,
      // and a definitions run without the model as one with none missing.
      if (model && !llm) throw new Error('tier 2 needs a model client: compose the tools with a Gemini config');
      if (definitions && !model) throw new Error('--definitions extends tier 2: ask for the model too');
      const work = await transaction(({ gloss }) => gloss.findMergeWork());
      const plan: MergePlan = { merges: [], definitions: [], suggestions: [], skipped: 0 };
      // Every gloss a merge already takes away, so no later merge names it again.
      const planned = new Set<string>();
      const baseOf = (item: MergeWork) => ({ lexemeId: item.lexemeId, userLanguageCode: item.userLanguageCode, lemma: item.lemma });

      // Tier 1. A pair needs two live glosses, so a headword with one costs no read.
      for (const item of work) {
        if (item.glosses.length < 2) continue;
        const keyOf = new Map(item.glosses.map((g) => [g.id, g.key]));
        const candidates = await transaction(({ gloss }) =>
          gloss.findMergeCandidates({ lexemeId: item.lexemeId, userLanguageCode: item.userLanguageCode }),
        );
        for (const pair of candidates) {
          planned.add(pair.otherId);
          plan.merges.push({ ...baseOf(item), ...pair, survivorKey: keyOf.get(pair.survivorId)!, otherKey: keyOf.get(pair.otherId)!, tier: 1 });
        }
        for (const [a, b] of mutualPairs(item.glosses)) plan.suggestions.push({ lemma: item.lemma, keys: [keyOf.get(a)!, keyOf.get(b)!] });
      }
      if (!model || !llm) return plan;
      const client = llm;

      /** One headword's call, planned into `plan`; false when skipped. */
      const ask = async (item: MergeWork): Promise<boolean> => {
        const prompt = buildGlossMergePrompt({
          lemma: item.lemma,
          partOfSpeech: item.partOfSpeech,
          from: item.languageCode as LanguageCode,
          to: item.userLanguageCode as LanguageCode,
          glosses: item.glosses,
          senses: item.senses,
        });
        let raw: string;
        try {
          raw = await client(prompt);
        } catch (error) {
          if (!(error instanceof LlmUnavailable)) throw error;
          logger.info({
            event: 'gloss_merge_unavailable',
            lexeme_id: item.lexemeId,
            user_language_code: item.userLanguageCode,
            reason: error.message,
          });
          return false;
        }
        const answer = parseGlossMerge(raw);
        if (!answer) {
          logger.info({ event: 'gloss_merge_unreadable', lexeme_id: item.lexemeId, user_language_code: item.userLanguageCode });
          return false;
        }
        const byKey = new Map(item.glosses.map((g) => [normaliseGloss(g.key), g]));
        for (const group of answer.groups) {
          const [survivor, ...others] = group.flatMap((word) => {
            const found = byKey.get(normaliseGloss(word));
            return found ? [found] : [];
          });
          for (const other of others) {
            if (!survivor || other.id === survivor.id || planned.has(other.id)) continue;
            planned.add(other.id);
            plan.merges.push({ ...baseOf(item), survivorId: survivor.id, survivorKey: survivor.key, otherId: other.id, otherKey: other.key, tier: 2 });
          }
        }
        const senseOf = new Map(item.senses.map((sense) => [sense.senseCode, sense]));
        for (const { senseCode, definition } of answer.definitions) {
          const sense = senseOf.get(senseCode);
          if (sense && sense.definition === null && definition !== '') plan.definitions.push({ senseId: sense.senseId, definition });
        }
        return true;
      };

      // Tier 2.
      const asked = work.filter((item) => asksModel(item, definitions));
      onProgress({ kind: 'asking', headwords: asked.length });
      for (const [index, item] of asked.entries()) {
        const before = { merges: plan.merges.length, definitions: plan.definitions.length };
        const answered = await ask(item);
        if (!answered) plan.skipped += 1;
        onProgress({
          kind: 'asked',
          done: index + 1,
          of: asked.length,
          lemma: item.lemma,
          partOfSpeech: item.partOfSpeech,
          userLanguageCode: item.userLanguageCode,
          merges: plan.merges.length - before.merges,
          definitions: plan.definitions.length - before.definitions,
          skipped: !answered,
        });
      }
      return plan;
    },

    /** Applies a plan: one transaction per merge, under its lexeme's lock, then
     *  the definitions. A merge whose glosses a previous one already folded is a
     *  no-op (mergeGlosses returns null). */
    applyMerges: async (plan: MergePlan): Promise<{ merged: number; definitions: number }> => {
      let merged = 0;
      for (const merge of plan.merges) {
        const counts = await transaction(async ({ dict, gloss }) => {
          await dict.lockLexemes([merge.lexemeId]);
          return gloss.mergeGlosses({ survivorId: merge.survivorId, otherId: merge.otherId });
        });
        if (!counts) continue;
        merged += 1;
        logger.info({ ...glossMerged({ lexemeId: merge.lexemeId, userLanguageCode: merge.userLanguageCode, survivorId: merge.survivorId, otherId: merge.otherId, counts }), tier: merge.tier });
      }
      const definitions = plan.definitions.length === 0 ? 0 : await transaction(({ gloss }) => gloss.setDefinitions(plan.definitions));
      return { merged, definitions };
    },
  };
}

export type GlossService = ReturnType<typeof createGlossService>;
