// Authoring source for the shared content the seed inserts, split by who
// writes it: the quiz is authored here by hand, the answers are recorded into
// ./content.generated.ts by `npm run content:generate`.
//
// Not runtime data: nothing reads this at request time — `repo/questions.ts`
// reads the database.

import type { LanguageCode } from '../domain/languages';
import type { QuestionOption } from './schema';
import { recorded } from './content.generated';

export type ContentEntry = {
  /** The lookup this recording answers: `from` is the language the query is in,
   *  `to` the language its options are in. A seeded question's
   *  target_language is `from`. */
  from: LanguageCode;
  to: LanguageCode;
  /** What a learner would type. The recorder's input, the variant's form,
   *  and the quiz prompt — one string doing all three, honestly. */
  query: string;
  question_id: string;
  /** Three wrong answers. The right one is the recorded sense's translation,
   *  spliced in at `correct_option`, so the two can never drift apart. */
  distractors: [string, string, string];
  correct_option: number;
};

/** A recording's key: the pair and the query, because the same string may one
 *  day be seeded under two pairs, and a bare query would collide. */
export function recordingKey(entry: Pick<ContentEntry, 'from' | 'to' | 'query'>): string {
  return `${entry.from}-${entry.to}:${entry.query}`;
}

/** What `npm run content:generate` was asked to re-record: an optional query
 *  and an optional `--pair <from>-<to>`. Pure, and here rather than beside the
 *  recorder, because tests/eval/ holds no *.test.ts (ADR 0004 R4) and this is
 *  the one part of the recorder worth a unit test: a query the parser drops
 *  turns a one-entry re-record into a paid, unreviewed re-record of every
 *  entry. */
export function parseRecordArgs(args: readonly string[]): { filter?: string; pair?: string } {
  const pairIndex = args.indexOf('--pair');
  let pair: string | undefined;
  if (pairIndex >= 0) {
    pair = args[pairIndex + 1];
    if (pair === undefined || pair.startsWith('--')) {
      throw new Error('--pair needs a value, e.g. --pair ru-he.');
    }
  }
  const filter = args.find(
    (arg, index) => !arg.startsWith('--') && (pairIndex < 0 || index !== pairIndex + 1),
  );
  return { filter, pair };
}

/**
 * The right answer, derived rather than authored. It used to be a fourth
 * literal in `options`, duplicating the translation; splicing it in from the
 * recording removes the duplicate and the drift it invites — a regeneration
 * that changes ספר cannot leave a quiz asking for a word the dictionary no
 * longer holds.
 *
 * The question tests entry 0, sense 0 of its query's recording. Nothing selects
 * a different one today, and a field for it would be a guess about a need
 * nobody has.
 */
export function correctAnswerFor(entry: ContentEntry): string {
  const sense = recorded[recordingKey(entry)]?.entries[0]?.senses[0];
  if (!sense) {
    throw new Error(
      `no recording for "${recordingKey(entry)}". Run \`npm run content:generate -- ${entry.query}\`.`,
    );
  }
  return sense.translation;
}

export function optionsFor(entry: ContentEntry): QuestionOption[] {
  const texts: string[] = [...entry.distractors];
  texts.splice(entry.correct_option, 0, correctAnswerFor(entry));
  return texts.map((text, position) => ({
    position,
    text,
    is_correct: position === entry.correct_option,
  }));
}

export const content: ContentEntry[] = [
  { from: 'en', to: 'he', query: 'window', question_id: 'q-window', distractors: ['דלת', 'שולחן', 'קיר'], correct_option: 1 },
  { from: 'en', to: 'he', query: 'book', question_id: 'q-book', distractors: ['עיפרון', 'מחשב', 'כיסא'], correct_option: 0 },
  { from: 'en', to: 'he', query: 'water', question_id: 'q-water', distractors: ['לחם', 'חלב', 'קפה'], correct_option: 2 },
  { from: 'en', to: 'he', query: 'friend', question_id: 'q-friend', distractors: ['שכן', 'מורה', 'רופא'], correct_option: 3 },
  { from: 'en', to: 'he', query: 'difficult', question_id: 'q-difficult', distractors: ['קל', 'חשוב', 'מהיר'], correct_option: 1 },
  { from: 'en', to: 'he', query: 'to remember', question_id: 'q-remember', distractors: ['לשכוח', 'ללמוד', 'לחשוב'], correct_option: 1 },
  { from: 'en', to: 'he', query: 'excuse me', question_id: 'q-excuse-me', distractors: ['שלום', 'תודה', 'בבקשה'], correct_option: 2 },
  { from: 'en', to: 'he', query: 'good morning', question_id: 'q-good-morning', distractors: ['לילה טוב', 'ערב טוב', 'שבוע טוב'], correct_option: 1 },
  { from: 'en', to: 'he', query: 'thank you very much', question_id: 'q-thank-you-very-much', distractors: ['בבקשה רבה', 'סליחה רבה', 'שלום רב'], correct_option: 0 },
  { from: 'en', to: 'he', query: 'How do you do?', question_id: 'q-how-do-you-do', distractors: ['מה השעה?', 'מה קרה?', 'מה זה?'], correct_option: 1 },
  { from: 'en', to: 'he', query: 'see you later', question_id: 'q-see-you-later', distractors: ['נתראה מחר', 'ניפגש בבוקר', 'נדבר בהמשך'], correct_option: 1 },
  { from: 'en', to: 'he', query: 'Have a nice day!', question_id: 'q-have-a-nice-day', distractors: ['שיהיה לך בוקר טוב!', 'שיהיה לך שבוע טוב!', 'שיהיה לך לילה טוב!'], correct_option: 0 },
  { from: 'en', to: 'he', query: 'Nice to meet you', question_id: 'q-nice-to-meet-you', distractors: ['טוב לראות אותך', 'נתראה בקרוב', 'תודה שבאת'], correct_option: 0 },
  // Phase 16. ru → he. Hebrew distractors, hand-written; the right answer is
  // spliced in from the recording, as for English. Reviewed by Victor, who reads
  // both languages (spec §4).
  { from: 'ru', to: 'he', query: 'окно', question_id: 'q-ru-okno', distractors: ['דלת', 'קיר', 'תקרה'], correct_option: 2 },
  { from: 'ru', to: 'he', query: 'книга', question_id: 'q-ru-kniga', distractors: ['מחברת', 'עיתון', 'מכתב'], correct_option: 0 },
  { from: 'ru', to: 'he', query: 'вода', question_id: 'q-ru-voda', distractors: ['חלב', 'מיץ', 'תה'], correct_option: 1 },
  { from: 'ru', to: 'he', query: 'друг', question_id: 'q-ru-drug', distractors: ['שכן', 'אח', 'מורה'], correct_option: 3 },
  { from: 'ru', to: 'he', query: 'трудный', question_id: 'q-ru-trudnyj', distractors: ['קל', 'מהיר', 'חשוב'], correct_option: 0 },
  { from: 'ru', to: 'he', query: 'помнить', question_id: 'q-ru-pomnit', distractors: ['לשכוח', 'לחשוב', 'לדעת'], correct_option: 2 },
  { from: 'ru', to: 'he', query: 'извините', question_id: 'q-ru-izvinite', distractors: ['תודה', 'בבקשה', 'שלום'], correct_option: 1 },
  { from: 'ru', to: 'he', query: 'доброе утро', question_id: 'q-ru-dobroe-utro', distractors: ['ערב טוב', 'לילה טוב', 'צהריים טובים'], correct_option: 3 },
  { from: 'ru', to: 'he', query: 'спасибо большое', question_id: 'q-ru-spasibo-bolshoe', distractors: ['בבקשה', 'סליחה רבה', 'להתראות'], correct_option: 0 },
  // Not שלום as a distractor: it means goodbye too, so it would be a second right answer.
  { from: 'ru', to: 'he', query: 'до свидания', question_id: 'q-ru-do-svidaniya', distractors: ['ברוך הבא', 'תודה', 'בהצלחה'], correct_option: 2 },
];
