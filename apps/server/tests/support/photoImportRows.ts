import type { PhotoImportOption } from '@lang-tutor/core/api';

import type { Db } from '../../src/db/client';
import { photoImportItems, photoImports } from '../../src/db/schema';

export type SeedItem = {
  text: string;
  hebrew?: string | null;
  status?: 'pending' | 'ready' | 'failed';
  options?: PhotoImportOption[];
  chosenSenseId?: string | null;
  ticked?: boolean;
  hebrewMismatch?: boolean;
};

/** An import in any state, with rows, for tests about reviewing and saving.
 *  A row with options defaults to ready, ticked, on its first option. */
export async function seedPhotoImport(
  db: Db,
  input: {
    enrollmentId: string;
    status: 'reading' | 'read' | 'failed' | 'saved' | 'discarded';
    createdAt?: Date;
    items: SeedItem[];
  },
): Promise<string> {
  const [row] = await db
    .insert(photoImports)
    .values({
      enrollmentId: input.enrollmentId,
      status: input.status,
      photo: input.status === 'reading' ? 'QUJD' : null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: photoImports.id });
  if (input.items.length > 0) {
    await db.insert(photoImportItems).values(
      input.items.map((item, position) => {
        const options = item.options ?? [];
        const chosen = item.chosenSenseId !== undefined ? item.chosenSenseId : (options[0]?.sense_id ?? null);
        return {
          importId: row.id,
          position,
          text: item.text,
          hebrew: item.hebrew ?? null,
          status: item.status ?? (options.length > 0 ? 'ready' : 'pending'),
          options,
          suggestedSenseId: chosen,
          chosenSenseId: chosen,
          ticked: item.ticked ?? chosen !== null,
          hebrewMismatch: item.hebrewMismatch ?? false,
        };
      }),
    );
  }
  return row.id;
}
