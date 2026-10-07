import { LlmPhotoReadingSchema } from '@lang-tutor/core/api/schemas';

import { normalizeForm } from './dictionary';
import { LANGUAGES, stripStress, type LanguageCode } from './languages';
import { dropNulls, unfence } from './translation';

/**
 * Phase 26 (spec D5). The pure half of reading a photo: what to ask the model,
 * and what its answer means. services/photoImports.ts sends the photo.
 *
 * The prompt lives here, not in the provider, so `npm run eval` scores exactly
 * what production sends, as it does for the lookup.
 */

/** In the instruction verbatim, so MockServer can tell this call from the
 *  others, as DISTRACTOR_MARKER does. */
export const PHOTO_READING_MARKER = 'read the word list in this photo';

/** The lookup refuses longer input (TranslationRequestSchema), and a longer
 *  item is a sentence, not a vocabulary item. */
export const MAX_ITEM_LENGTH = 100;

export type ReadItem = { text: string; hebrew: string | null };

export type PhotoReadingPrompt = {
  system: string;
  user: string;
  schema: typeof LlmPhotoReadingSchema;
};

export function buildPhotoReadingPrompt(target: LanguageCode): PhotoReadingPrompt {
  const name = LANGUAGES[target].name;
  const system = [
    `You ${PHOTO_READING_MARKER} for a Hebrew speaker learning ${name}.`,
    `Return every vocabulary item written in ${name}, in page order: top to bottom, and column by column when the list has several columns.`,
    'Return JSON only, matching the supplied schema.',
    'Rules:',
    `1. Only items in ${name}. Skip headings, titles, instructions, exercise text, example sentences, page numbers, exercise numbers, dates, and anything crossed out.`,
    // The `take care of sb` example came with rule 7, which on its own made the
    // model keep `sb` and `sth` on en-printed-plain (see rule 7). It is in no
    // fixture.
    '2. Write each item the way the learner would type it into a dictionary: drop a leading article or the infinitive marker "to" (il gatto -> gatto, to run -> run), unless the item is a fixed expression; drop grammar labels such as (m.), (f.), (pl.), (v.), (n.), (adj.), (conj.), and the placeholders sb and sth (take care of sb -> take care of); drop stress marks over vowels; otherwise keep the item exactly as written.',
    '3. If Hebrew is written next to an item as its translation, copy that Hebrew whole, with all its glosses, into "hebrew". Otherwise "hebrew" is an empty string.',
    '4. When handwriting is unclear, give your best reading rather than leaving the item out.',
    '5. Never translate, explain, or add an item that is not on the page.',
    '6. A word with a line drawn through it is crossed out: skip it, even when nothing is written beside it.',
    // Phase 26 follow-up. Kept whole, `decorate / decoration` was looked up as
    // one form and written into the dictionary as a form of both lexemes. Only
    // the model can tell the two kinds of slash apart: no rule in code can,
    // with `amico/a` on Italian pages and `9/11` already a dictionary form.
    //
    // Each part of the shape was measured against the drafts it replaced:
    // - It says nothing about the Hebrew. "each with the item's Hebrew whole"
    //   made 3 of 9 reads of en-textbook-handwritten come back with nikud and
    //   a misread gloss; as written, 8 of 8 read it cleanly, as master did 5
    //   of 5. Rule 3 already says to copy the Hebrew whole, and a split half
    //   matches as well (glossesOf).
    // - It is its own rule. Folded into rule 2, it read `לאמן` beside `train`
    //   as `רכבת` in 8 of 8 reads of that page.
    // - Rule 2 does not point at it. With "except as rule 7 says" there, every
    //   read of en-printed-plain kept `sb` and `sth` (8 of 8); without it, 4
    //   of 8 still did, and the example in rule 2 brought that to 0 of 8.
    '7. A slash inside an item joins either different words or forms of one word. Different words, as in "decide / decision": return each word as its own item, in the order written. Forms of one word, such as another tense ("sing / sang") or another ending or article ("rosso/a", "un/una"): return one item, the word in its dictionary form ("sing", "rosso").',
  ].join('\n');
  return { system, user: `Language: ${name}.`, schema: LlmPhotoReadingSchema };
}

export type PhotoReading = { items: ReadItem[]; mergedCount: number; droppedCount: number };

/** `null` means unreadable: the job throws and pg-boss retries. An empty list
 *  is a photo with no words in the language, which is an answer. */
export function parsePhotoReading(raw: string): PhotoReading | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmPhotoReadingSchema.safeParse(dropNulls(json));
  if (!result.success) return null;

  const seen = new Set<string>();
  const items: ReadItem[] = [];
  let mergedCount = 0;
  let droppedCount = 0;
  for (const item of result.data.items) {
    const text = stripStress(item.text).replace(/\s+/g, ' ').trim();
    if (text === '' || text.length > MAX_ITEM_LENGTH) {
      droppedCount += 1;
      continue;
    }
    // The dictionary's own key, lower-cased: `Gatto` and ` gatto ` are one word.
    const key = normalizeForm(text).toLowerCase();
    if (seen.has(key)) {
      mergedCount += 1;
      continue;
    }
    seen.add(key);
    const hebrew = item.hebrew.trim();
    items.push({ text, hebrew: hebrew === '' ? null : hebrew });
  }
  return { items, mergedCount, droppedCount };
}
