import type { QuestionOption } from './schema';
import type { Db } from './client';
import { content, type ContentEntry } from './content';
import { questions, termSenseTranslations, termVariants, vocabTerms, vocabTermSenses } from './schema';

const TARGET_LANGUAGE = 'en';
const USER_LANGUAGE = 'he';

function variantId(entry: ContentEntry): string {
  return `tv-${TARGET_LANGUAGE}-${entry.question_id.replace(/^q-/, '')}-${entry.prompt_kind}`;
}

function senseId(entry: ContentEntry): string {
  return `sense-${entry.question_id.replace(/^q-/, '')}-default`;
}

function optionsOf(entry: ContentEntry): QuestionOption[] {
  return entry.options.map((text, position) => ({
    position,
    text,
    is_correct: position === entry.correct_option,
  }));
}

/**
 * Inserts the shared content layers: terms, their variants and senses, the
 * Hebrew translations, and the shared questions (user_id NULL). Idempotent, so
 * it can run on every `db:migrate` and on every per-worker test template.
 *
 * Per-learner questions are not seeded — nothing generates them in this phase.
 */
export async function seedContent(db: Db): Promise<void> {
  if (content.length === 0) return;

  await db
    .insert(vocabTerms)
    .values(
      content.map((entry) => ({
        id: entry.term_id,
        languageCode: TARGET_LANGUAGE,
        lemma: entry.lemma,
        partOfSpeech: entry.part_of_speech,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(termVariants)
    .values(
      content.map((entry) => ({
        id: variantId(entry),
        termId: entry.term_id,
        form: entry.prompt,
        kind: entry.prompt_kind,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(vocabTermSenses)
    .values(
      content.map((entry) => ({
        id: senseId(entry),
        termId: entry.term_id,
        senseCode: 'default',
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(termSenseTranslations)
    .values(
      content.map((entry) => ({
        senseId: senseId(entry),
        userLanguageCode: USER_LANGUAGE,
        translation: entry.translation,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(questions)
    .values(
      content.map((entry) => ({
        id: entry.question_id,
        userId: null,
        senseId: senseId(entry),
        promptVariantId: variantId(entry),
        targetLanguage: TARGET_LANGUAGE,
        userLanguageCode: USER_LANGUAGE,
        type: 'multiple_choice',
        options: optionsOf(entry),
      })),
    )
    .onConflictDoNothing();
}
