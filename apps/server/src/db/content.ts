// Authoring source for the shared content the seed inserts, split by who
// writes it: the quiz is authored here by hand, the answers are recorded into
// ./content.generated.ts by `npm run content:generate`.
//
// Not runtime data: nothing reads this at request time — `repo/questions.ts`
// reads the database.

import type { QuestionOption } from './schema';
import { recorded } from './content.generated';

export type ContentEntry = {
  /** What a learner would type. The recorder's input, the variant's form,
   *  and the quiz prompt — one string doing all three, honestly. */
  query: string;
  question_id: string;
  /** Three wrong answers. The right one is the recorded sense's translation,
   *  spliced in at `correct_option`, so the two can never drift apart. */
  distractors: [string, string, string];
  correct_option: number;
};

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
  const sense = recorded[entry.query]?.entries[0]?.senses[0];
  if (!sense) {
    throw new Error(
      `no recording for "${entry.query}". Run \`npm run content:generate -- ${entry.query}\`.`,
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
  { query: 'window', question_id: 'q-window', distractors: ['דלת', 'שולחן', 'קיר'], correct_option: 1 },
  { query: 'book', question_id: 'q-book', distractors: ['עיפרון', 'מחשב', 'כיסא'], correct_option: 0 },
  { query: 'water', question_id: 'q-water', distractors: ['לחם', 'חלב', 'קפה'], correct_option: 2 },
  { query: 'friend', question_id: 'q-friend', distractors: ['שכן', 'מורה', 'רופא'], correct_option: 3 },
  { query: 'difficult', question_id: 'q-difficult', distractors: ['קל', 'חשוב', 'מהיר'], correct_option: 1 },
  { query: 'to remember', question_id: 'q-remember', distractors: ['לשכוח', 'ללמוד', 'לחשוב'], correct_option: 1 },
  { query: 'excuse me', question_id: 'q-excuse-me', distractors: ['שלום', 'תודה', 'בבקשה'], correct_option: 2 },
  { query: 'good morning', question_id: 'q-good-morning', distractors: ['לילה טוב', 'ערב טוב', 'שבוע טוב'], correct_option: 1 },
  { query: 'thank you very much', question_id: 'q-thank-you-very-much', distractors: ['בבקשה רבה', 'סליחה רבה', 'שלום רב'], correct_option: 0 },
  { query: 'How do you do?', question_id: 'q-how-do-you-do', distractors: ['מה השעה?', 'מה קרה?', 'מה זה?'], correct_option: 1 },
  { query: 'see you later', question_id: 'q-see-you-later', distractors: ['נתראה מחר', 'ניפגש בבוקר', 'נדבר בהמשך'], correct_option: 1 },
  { query: 'Have a nice day!', question_id: 'q-have-a-nice-day', distractors: ['שיהיה לך בוקר טוב!', 'שיהיה לך שבוע טוב!', 'שיהיה לך לילה טוב!'], correct_option: 0 },
  { query: 'Nice to meet you', question_id: 'q-nice-to-meet-you', distractors: ['טוב לראות אותך', 'נתראה בקרוב', 'תודה שבאת'], correct_option: 0 },
];
