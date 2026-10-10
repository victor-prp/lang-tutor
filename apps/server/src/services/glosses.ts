import { normaliseGloss } from '@lang-tutor/core/domain';

import { buildGlossMergePrompt, mutualPairs, parseGlossMerge } from '../domain/glossMerge';
import { MergeGlossesPayloadSchema } from '../domain/jobs';
import type { LanguageCode } from '../domain/languages';
import { LlmUnavailable } from '../errors';
import type { Logger } from '../logger';
import type { MergeCounts } from '../repo/glosses';
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

/**
 * Phase 31 (spec D7). The gloss use cases that are not a lookup: the merge job,
 * and the by-hand tool's plan and apply. A merge runs here, outside the lookup,
 * in a transaction of its own under the lexeme's lock; the lookup only ever asks
 * for one. `llm` is the tool's model tier: createGlossTools passes one, and the
 * server's service, which nothing asks for a plan, is handed null.
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
     * dictionary; tier 2 (`model`) asks the model, once per lexeme and language,
     * which target words are forms of one word, and for missing definitions.
     * Mutual-alternative pairs are listed as suggestions and never merged.
     * Writes nothing. The model is called outside any transaction (ADR 0001 R8).
     * A headword whose call fails (LlmUnavailable) or answers unreadably is
     * logged and skipped, and the rest are still planned: one call in thousands
     * must not cost the run. Any other error is a bug, and stops it.
     */
    planMerges: async ({ model }: { model: boolean }): Promise<MergePlan> => {
      const work = await transaction(({ gloss }) => gloss.findMergeWork());
      const plan: MergePlan = { merges: [], definitions: [], suggestions: [], skipped: 0 };
      for (const item of work) {
        const keyOf = new Map(item.glosses.map((g) => [g.id, g.key]));
        const planned = new Set<string>();
        const base = { lexemeId: item.lexemeId, userLanguageCode: item.userLanguageCode, lemma: item.lemma };
        // A pair needs two live glosses: an item here for a missing definition
        // alone costs no read.
        const candidates =
          item.glosses.length < 2
            ? []
            : await transaction(({ gloss }) =>
                gloss.findMergeCandidates({ lexemeId: item.lexemeId, userLanguageCode: item.userLanguageCode }),
              );
        for (const pair of candidates) {
          planned.add(pair.otherId);
          plan.merges.push({ ...base, ...pair, survivorKey: keyOf.get(pair.survivorId)!, otherKey: keyOf.get(pair.otherId)!, tier: 1 });
        }
        for (const [a, b] of mutualPairs(item.glosses)) plan.suggestions.push({ lemma: item.lemma, keys: [keyOf.get(a)!, keyOf.get(b)!] });
        if (!model || !llm) continue;

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
          raw = await llm(prompt);
        } catch (error) {
          if (!(error instanceof LlmUnavailable)) throw error;
          plan.skipped += 1;
          logger.info({
            event: 'gloss_merge_unavailable',
            lexeme_id: item.lexemeId,
            user_language_code: item.userLanguageCode,
            reason: error.message,
          });
          continue;
        }
        const answer = parseGlossMerge(raw);
        if (!answer) {
          plan.skipped += 1;
          logger.info({ event: 'gloss_merge_unreadable', lexeme_id: item.lexemeId, user_language_code: item.userLanguageCode });
          continue;
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
            plan.merges.push({ ...base, survivorId: survivor.id, survivorKey: survivor.key, otherId: other.id, otherKey: other.key, tier: 2 });
          }
        }
        const senseOf = new Map(item.senses.map((sense) => [sense.senseCode, sense]));
        for (const { senseCode, definition } of answer.definitions) {
          const sense = senseOf.get(senseCode);
          if (sense && sense.definition === null && definition !== '') plan.definitions.push({ senseId: sense.senseId, definition });
        }
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
