import { ACCEPT_RENDERING, acceptRenderingKey } from '../domain/jobs';
import { createDictRepo } from '../repo/dictionary';
import { createJobRepo } from '../repo/jobs';
import type { Db } from './client';
import { withJobQueue } from './jobs';
import { createTransaction } from './transaction';

/**
 * Phase 34 (spec D13). `npm run dict:accept`: asks for the accept job for every
 * rendering, in its learner language, of a saved gloss's member senses that the
 * job has never run for. It saves the first sessions after the deploy from
 * falling back on every card; the lazy enqueue in prepareSession would get
 * there anyway. On demand only, wherever DATABASE_URL points: unlike the lemma
 * backfill it is not run at start. A second run asks again only for what is
 * still unstamped, and the queue keeps one job per rendering, so a rendering
 * already queued is not asked twice.
 */
export async function requestAcceptRenderings(db: Db): Promise<{ requested: number }> {
  return withJobQueue(db, async (boss) => {
    const inTransaction = createTransaction(db, (tx) => ({ dict: createDictRepo(tx), jobs: createJobRepo(tx, boss) }));
    return inTransaction(async ({ dict, jobs }) => {
      const renderings = await dict.findUnacceptedSavedRenderings();
      for (const rendering of renderings) {
        const payload = {
          variant_id: rendering.variantId,
          sense_id: rendering.senseId,
          user_language_code: rendering.userLanguageCode,
        };
        await jobs.enqueue(ACCEPT_RENDERING, payload, { singletonKey: acceptRenderingKey(payload) });
      }
      return { requested: renderings.length };
    });
  });
}
