import type { MissedQuestion, Question } from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { mockQuestions } from '@/data/mockQuestions';
import {
  SESSION_LENGTH,
  advance,
  answer,
  createSession,
  currentQuestion,
  isAnswered,
  isComplete,
  missedQuestions,
  progress,
  sessionScore,
  type SessionState,
} from '@/session';

export type SessionValue = {
  hasSession: boolean;
  question: Question | undefined;
  position: number;
  total: number;
  selectedOption: number | null;
  answered: boolean;
  complete: boolean;
  correctCount: number;
  missedQuestions: MissedQuestion[];
  start: () => void;
  select: (optionIndex: number) => void;
  next: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  // Phase 1 keeps session state in memory. Persistence, points and daily
  // targets all land here later, and no screen changes when they do.
  const [state, setState] = useState<SessionState | null>(null);

  const start = useCallback(() => {
    setState(createSession(mockQuestions));
  }, []);

  const select = useCallback((optionIndex: number) => {
    setState((current) => (current ? answer(current, optionIndex) : current));
  }, []);

  const next = useCallback(() => {
    setState((current) => (current ? advance(current) : current));
  }, []);

  const value = useMemo<SessionValue>(() => {
    if (!state) {
      return {
        hasSession: false,
        question: undefined,
        position: 0,
        total: SESSION_LENGTH,
        selectedOption: null,
        answered: false,
        complete: false,
        correctCount: 0,
        missedQuestions: [],
        start,
        select,
        next,
      };
    }
    const { position, total } = progress(state);
    return {
      hasSession: true,
      question: currentQuestion(state),
      position,
      total,
      selectedOption: state.selected_option,
      answered: isAnswered(state),
      complete: isComplete(state),
      correctCount: sessionScore(state).correct,
      missedQuestions: missedQuestions(state),
      start,
      select,
      next,
    };
  }, [state, start, select, next]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return value;
}
