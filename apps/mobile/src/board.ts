import type { MatchingQuestion } from '@lang-tutor/core/api';

/**
 * Phase 24 (spec D10). A matching board's play as pure state: which words are
 * matched, each word's first-tried meaning, and what is selected. The view
 * renders it and the session submits `firstAttempts` once every word is
 * matched. Words before the current question were answered before a resume:
 * they start matched and are not submitted again.
 */
export type BoardState = {
  /** The board index of the first word this screen plays. */
  start: number;
  matched: boolean[];
  /** The meaning each word was first paired with, or null before any try. */
  first: (number | null)[];
  word: number | null;
  meaning: number | null;
  /** The last wrong pair, shown until the next tap. */
  miss: { word: number; meaning: number } | null;
};

export function startBoard(question: MatchingQuestion): BoardState {
  const start = question.board.question_ids.indexOf(question.id);
  return {
    start,
    matched: question.board.words.map((_, index) => index < start),
    first: question.board.words.map(() => null),
    word: null,
    meaning: null,
    miss: null,
  };
}

/** Whether a meaning already belongs to a matched word. */
export function meaningTaken(state: BoardState, question: MatchingQuestion, meaning: number): boolean {
  return question.board.correct_options.some((correct, word) => state.matched[word] && correct === meaning);
}

// A wrong pair is charged to the word: it shows the learner did not know that
// word's meaning, not that they did not know the other word's.
function pair(state: BoardState, question: MatchingQuestion, word: number, meaning: number): BoardState {
  const right = question.board.correct_options[word] === meaning;
  return {
    ...state,
    first: state.first.map((tried, index) => (index === word && tried === null ? meaning : tried)),
    matched: right ? state.matched.map((done, index) => done || index === word) : state.matched,
    word: null,
    meaning: null,
    miss: right ? null : { word, meaning },
  };
}

export function tapWord(state: BoardState, question: MatchingQuestion, word: number): BoardState {
  if (state.matched[word]) return state;
  if (state.meaning !== null) return pair(state, question, word, state.meaning);
  return { ...state, word: state.word === word ? null : word, miss: null };
}

export function tapMeaning(state: BoardState, question: MatchingQuestion, meaning: number): BoardState {
  if (meaningTaken(state, question, meaning)) return state;
  if (state.word !== null) return pair(state, question, state.word, meaning);
  return { ...state, meaning: state.meaning === meaning ? null : meaning, miss: null };
}

/** The first-tried meaning of every word this screen played, in board order;
 *  null until the last word is matched. */
export function firstAttempts(state: BoardState): number[] | null {
  if (!state.matched.every(Boolean)) return null;
  return state.first.slice(state.start).map((meaning) => meaning!);
}
