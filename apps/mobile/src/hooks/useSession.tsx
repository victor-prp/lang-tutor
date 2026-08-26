import type { MissedQuestion, Question, Score } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';

import { createSession, nextStep } from '@/api/client';
import { strings } from '@/strings';
import { getOrCreateUserId } from '@/userId';

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

// What the background next-step call resolved to, waiting to be applied when
// the learner taps Continue. Only one of these is ever in flight at a time,
// since `select` cannot fire again until a new question is on screen.
type Queued =
  | { complete: false; question: Question; position: number }
  | { complete: true; score: Score; missedQuestions: MissedQuestion[] };

type QuizState = {
  sessionId: string;
  userId: string;
  question: Question | undefined;
  position: number;
  total: number;
  selectedOption: number | null;
  complete: boolean;
  correctCount: number;
  missedQuestions: MissedQuestion[];
  queued: Queued | null;
  // Set when Continue is tapped before the background next-step call has
  // resolved. Applied the moment that call does resolve, so the learner
  // never has to tap Continue a second time.
  advanceRequested: boolean;
};

const SessionContext = createContext<SessionValue | null>(null);

function handleApiFailure() {
  Alert.alert(strings.errorTitle, strings.errorMessage, [
    { text: strings.errorAction, onPress: () => router.replace('/') },
  ]);
}

function applyQueued(current: QuizState, queued: Queued): QuizState {
  if (queued.complete) {
    return {
      ...current,
      question: undefined,
      complete: true,
      correctCount: queued.score.correct,
      missedQuestions: queued.missedQuestions,
      selectedOption: null,
      queued: null,
      advanceRequested: false,
    };
  }
  return {
    ...current,
    question: queued.question,
    position: queued.position,
    selectedOption: null,
    queued: null,
    advanceRequested: false,
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // Phase 2 still keeps a client-side copy of the current step for rendering,
  // but the server is now the source of truth for progress and scoring.
  const [state, setState] = useState<QuizState | null>(null);

  const start = useCallback(() => {
    void (async () => {
      try {
        const userId = await getOrCreateUserId();
        const response = await createSession({ user_id: userId });
        setState({
          sessionId: response.session_id,
          userId,
          question: response.question,
          position: response.position.position,
          total: response.position.total,
          selectedOption: null,
          complete: false,
          correctCount: 0,
          missedQuestions: [],
          queued: null,
          advanceRequested: false,
        });
      } catch {
        handleApiFailure();
      }
    })();
  }, []);

  // Reads `state` directly (and depends on it) rather than going through
  // setState's updater-function form, because the updater form is invoked
  // twice by React Strict Mode to catch exactly the kind of impurity that a
  // real network call inside it would be — nextStep must fire exactly once
  // per tap, so it stays outside any updater entirely.
  const select = useCallback(
    (optionIndex: number) => {
      if (!state || state.selectedOption !== null || !state.question) return;
      const { sessionId, userId, question } = state;

      setState((current) => (current ? { ...current, selectedOption: optionIndex } : current));

      // Fired in the background: correctness is already visible to the
      // learner from `question.correct_option` the moment this returns
      // (see MultipleChoiceView), so this call only has to register the
      // answer server-side and fetch what's next before Continue is tapped.
      void nextStep(sessionId, {
        user_id: userId,
        question_id: question.id,
        option_index: optionIndex,
      })
        .then((response) => {
          const queued: Queued = response.complete
            ? { complete: true, score: response.score, missedQuestions: response.missed_questions }
            : { complete: false, question: response.question, position: response.position.position };
          setState((latest) => {
            if (!latest || latest.sessionId !== sessionId) return latest;
            return latest.advanceRequested ? applyQueued(latest, queued) : { ...latest, queued };
          });
        })
        .catch(() => handleApiFailure());
    },
    [state],
  );

  const next = useCallback(() => {
    setState((current) => {
      if (!current) return current;
      return current.queued
        ? applyQueued(current, current.queued)
        : { ...current, advanceRequested: true };
    });
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
    return {
      hasSession: true,
      question: state.question,
      position: state.position,
      total: state.total,
      selectedOption: state.selectedOption,
      answered: state.selectedOption !== null,
      complete: state.complete,
      correctCount: state.correctCount,
      missedQuestions: state.missedQuestions,
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
