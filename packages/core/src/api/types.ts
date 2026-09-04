export type MultipleChoiceQuestion = {
  id: string;
  type: 'multiple_choice';
  vocab_term_id: string;
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

export type Position = {
  position: number;
  total: number;
};

export type CreateSessionRequest = {
  user_id: string;
};

export type CreateSessionResponse = {
  session_id: string;
  question: Question;
  position: Position;
};

export type NextStepRequest = {
  user_id: string;
  question_id: string;
  option_index: number;
};

// A discriminated union on `complete`: when true, the caller has everything
// the Results screen needs (score, missed_questions) in this same response —
// there is no separate results call.
export type NextStepResponse =
  | {
      session_id: string;
      question: Question;
      position: Position;
      complete: false;
    }
  | {
      session_id: string;
      question: null;
      position: Position;
      complete: true;
      score: Score;
      missed_questions: MissedQuestion[];
    };
