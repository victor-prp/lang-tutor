import type { Db } from './client';
import { content, optionsFor } from './content';
import { recorded } from './content.generated';
import { questions } from './schema';
import { createTransaction } from './transaction';
import { createVocabRepo } from '../repo/vocabulary';

const TARGET_LANGUAGE = 'en';
const USER_LANGUAGE = 'he';

/**
 * Replays the recorded provider answers through `persistEntries` — the same
 * repository function the translation service calls — and hangs one shared
 * question off each. Seeded rows and looked-up rows are then indistinguishable,
 * because they were made the same way, which is why nothing in this phase has
 * to ask which kind a row is.
 *
 * Idempotent for free: `persistEntries` is ON CONFLICT DO NOTHING on terms and
 * variants and first-writer-wins on senses, so a second run writes nothing.
 * That is also why re-recording has to be paired with clearing what is there —
 * see `db/reseed.ts`.
 *
 * The transaction comes from `createTransaction`, never opened directly on
 * `db` here: ADR 0001 R8 gives that primitive exactly one call site, in
 * db/transaction.ts. Reaching `repo/` from here is the sideways import R4
 * allows within the persistence layer.
 */
export async function seedContent(db: Db): Promise<void> {
  if (content.length === 0) return;

  const inTransaction = createTransaction(db, (tx) => tx);

  await inTransaction(async (tx) => {
    const vocab = createVocabRepo(tx);
    const rows = [];

    for (const entry of content) {
      const answer = recorded[entry.query];
      if (!answer || answer.entries.length === 0) {
        throw new Error(
          `no recording for "${entry.query}". Run \`npm run content:generate -- ${entry.query}\`.`,
        );
      }

      const { written } = await vocab.persistEntries({
        form: entry.query,
        languageCode: TARGET_LANGUAGE,
        userLanguageCode: USER_LANGUAGE,
        kind: answer.kind,
        entries: answer.entries,
      });

      // The question tests entry 0, sense 0 — the ids persistEntries just
      // reported, rather than ids this file invented.
      rows.push({
        id: entry.question_id,
        userId: null,
        senseId: written[0].senseIds[0],
        promptVariantId: written[0].variantId,
        targetLanguage: TARGET_LANGUAGE,
        userLanguageCode: USER_LANGUAGE,
        type: 'multiple_choice',
        options: optionsFor(entry),
      });
    }

    await tx.insert(questions).values(rows).onConflictDoNothing();
  });
}
