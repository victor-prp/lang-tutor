import { MergeGlossesPayloadSchema } from '../domain/jobs';
import type { Logger } from '../logger';
import type { MergeCounts } from '../repo/glosses';
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

/**
 * Phase 31 (spec D7). The gloss use cases that are not a lookup: the merge job.
 * A merge runs here, outside the lookup, in a transaction of its own under the
 * lexeme's lock; the lookup only ever asks for one.
 */
export function createGlossService({ transaction, logger }: { transaction: Transaction; logger: Logger }) {
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
  };
}

export type GlossService = ReturnType<typeof createGlossService>;
