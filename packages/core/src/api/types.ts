export type MultipleChoiceQuestion = {
  id: string;
  type: 'multiple_choice';
  vocab_entry_id: string;
  question: string;
  options: string[];
  correct_option: number;
};

// A tagged union with one member today. The `type` field exists from day one so
// consumers switch on it; adding a question type is then additive.
export type Question = MultipleChoiceQuestion;

// Scoring reads `is_correct` and nothing else, so any future question type
// satisfies it. `answer_string` is the audit-log field: text rather than an
// option index, because option order is shuffled per session.
export type AnswerRecord = {
  question_id: string;
  is_correct: boolean;
  answer_string: string;
};

export type Score = {
  correct: number;
  total: number;
};

export type MissedQuestion = {
  question: Question;
  correct_answer: string;
};
