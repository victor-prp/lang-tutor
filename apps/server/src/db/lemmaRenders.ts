import { RENDER_LEMMA } from '../domain/jobs';
import { createDictRepo } from '../repo/dictionary';
import { createJobRepo } from '../repo/jobs';
import type { Db } from './client';
import { withJobQueue } from './jobs';
import { createTransaction } from './transaction';

/**
 * Phase 31 (plan item 3; spec §2, "old glosses keyed from an inflected
 * rendering"). Asks for the render-lemma job for every saved gloss whose lexeme
 * has no lemma-form rendering in its enrollment's language and was never asked
 * for. The CLI's default path runs this after migrating and seeding, because that
 * is the only process that reaches production's database (ADR 0010); `npm run
 * dict:lemmas:render` runs it on demand. dict_lemma_renders records each request,
 * so a second run, or the next start, asks for nothing again.
 */
export async function requestLemmaRenders(db: Db): Promise<{ requested: number }> {
  return withJobQueue(db, async (boss) => {
    const inTransaction = createTransaction(db, (tx) => ({ dict: createDictRepo(tx), jobs: createJobRepo(tx, boss) }));
    return inTransaction(async ({ dict, jobs }) => {
      const claimed = await dict.claimSavedLemmaRenders();
      for (const pair of claimed) {
        await jobs.enqueue(RENDER_LEMMA, { lexeme_id: pair.lexemeId, user_language_code: pair.userLanguageCode });
      }
      return { requested: claimed.length };
    });
  });
}
