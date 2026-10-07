import type { MissedQuestion, NextStepResponse, Question, SessionProgressItem } from '@lang-tutor/core/api';
import { SESSION_LENGTH, type AnswerInput } from '@lang-tutor/core/domain';
import { router } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert } from 'react-native';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { CardAnswer } from '@/feedback';
import type { Clip } from '@/recording';
import { applyQueued, queuedFrom, type QuizState } from '@/quiz';
import { IDLE_ATTEMPT, passesUnseen, type SpeakingOff, type SpeechAttempt } from '@/speaking';
import { strings } from '@/strings';

export type SessionValue = {
  hasSession: boolean;
  question: Question | undefined;
  position: number;
  total: number;
  /** Phase 23. The answer to the card on screen: an option or a typed text. */
  answer: CardAnswer | null;
  /** The chosen option, for a choice card; null otherwise. */
  selectedOption: number | null;
  answered: boolean;
  complete: boolean;
  correctCount: number;
  missedQuestions: MissedQuestion[];
  /** Phase 20. Each practised saved word with its level before and after. */
  progress: SessionProgressItem[];
  /** The session id while one is loaded, for skip. */
  sessionId: string | null;
  /** Loads a ready session and continues from its current question. Starting
   *  and resuming are the same call: the server knows how far it got. */
  enter: (sessionId: string) => void;
  select: (optionIndex: number) => void;
  /** Phase 23. Answers a typed card. An empty text is "show me the answer". */
  submitText: (text: string) => void;
  /** Phase 24. Answers a board: each word's first-tried meaning, in board order. */
  submitBoard: (firstAttempts: number[]) => void;
  /** Phase 25. The speaking card's attempt that has recorded nothing yet. */
  speech: SpeechAttempt;
  /** Phase 25 (spec D8). Off for the rest of the session, and why. */
  speakingOff: SpeakingOff;
  /** Sends a recorded clip for the speaking card on screen. */
  submitSpeech: (clip: Clip) => void;
  /** Answers a speaking card without audio: skip, or show the answer. */
  pass: (kind: 'skip' | 'show_answer') => void;
  /** The recorder could not start: the card shows the "couldn't check" notice. */
  markSpeechFailed: () => void;
  /** Back to a fresh attempt after one that recorded nothing. */
  retrySpeech: () => void;
  /** "Can't speak now", or a refused microphone. */
  stopSpeaking: (reason: 'chosen' | 'no_mic') => void;
  next: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);

function handleApiFailure(message: string = strings.errorMessage) {
  // cancelable: false — Android otherwise lets the back button or a tap
  // outside dismiss this without invoking onPress, which would strand the
  // learner on a dead session screen with no way to get home.
  Alert.alert(
    strings.errorTitle,
    message,
    [{ text: strings.errorAction, onPress: () => router.replace('/') }],
    { cancelable: false },
  );
}

export function SessionProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  // Phase 2 still keeps a client-side copy of the current step for rendering,
  // but the server is now the source of truth for progress and scoring.
  const [state, setState] = useState<QuizState | null>(null);

  const { user } = useCurrentUser();

  // A ref, matching this file's existing stateRef idiom, so enter()'s
  // dependency array stays correct: the callback must read the user who is
  // logged in when it fires, not the one captured when it was created.
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Mirrors `state` for use inside async callbacks that resolve after a
  // render has moved on (e.g. select()'s nextStep().catch()), where the
  // callback's own closed-over `state` is stale and reading fresh state
  // requires either this ref or a side effect inside setState's updater.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const enter = useCallback(
    (sessionId: string) => {
      // Installed synchronously, before the read below, so `hasSession` flips
      // true on the same render enter() is called. Home navigates right after
      // calling it, and SessionScreen redirects home while hasSession is false.
      // `question` stays undefined until the read lands, which keeps select()
      // inert meanwhile.
      setState({
        sessionId,
        userId: '',
        question: undefined,
        position: 0,
        total: SESSION_LENGTH,
        answer: null,
        complete: false,
        correctCount: 0,
        missedQuestions: [],
        progress: [],
        queued: null,
        advanceRequested: false,
        speech: IDLE_ATTEMPT,
        speakingOff: null,
      });
      void (async () => {
        try {
          const currentUser = userRef.current;
          // Unreachable in practice (home redirects to /login when logged out),
          // but a session with no learner must fail loudly, not invent an id.
          if (!currentUser) throw new Error('cannot enter a session with no learner');
          const view = await api.getSession(sessionId);
          if (view.status !== 'ready' || !view.question) {
            throw new Error(`session ${sessionId} is ${view.status}`);
          }
          setState((latest) =>
            latest?.sessionId === sessionId
              ? {
                  ...latest,
                  userId: currentUser.id,
                  question: view.question!,
                  position: view.position.position,
                  total: view.position.total,
                }
              : latest,
          );
        } catch {
          if (stateRef.current?.sessionId === sessionId) handleApiFailure();
        }
      })();
    },
    [api],
  );

  // What a next-step response becomes once it lands: queued for Continue, or
  // applied at once when Continue was already tapped. Shared by a single
  // answer and a board's last one.
  const queueResponse = useCallback((sessionId: string, call: Promise<NextStepResponse>) => {
    void call
      .then((response) => {
        const queued = queuedFrom(response);
        setState((latest) => {
          if (!latest || latest.sessionId !== sessionId) return latest;
          return latest.advanceRequested ? applyQueued(latest, queued) : { ...latest, queued };
        });
      })
      .catch(() => {
        // The session may have been abandoned while this was in flight; only
        // the session it belongs to may alert. stateRef, not the stale closure.
        if (stateRef.current?.sessionId === sessionId) handleApiFailure();
      });
  }, []);

  // Reads `state` directly (and depends on it) rather than going through
  // setState's updater-function form, because the updater form is invoked
  // twice by React Strict Mode to catch exactly the kind of impurity that a
  // real network call inside it would be — nextStep must fire exactly once
  // per answer, so it stays outside any updater entirely.
  //
  // Phase 23: one path for a chosen option and a typed text. The guard on
  // `state.answer` is what makes a second tap, or Return then Check, a no-op.
  const answerWith = useCallback(
    (input: Exclude<AnswerInput, { heard: string }>) => {
      if (!state || state.answer !== null || !state.question) return;
      const { sessionId, userId, question } = state;

      setState((current) => (current ? { ...current, answer: input } : current));

      // Fired in the background: the verdict is already visible to the learner
      // the moment this returns (feedbackFor runs the server's own evaluate),
      // so this call only has to register the answer server-side and fetch
      // what's next before Continue is tapped.
      queueResponse(sessionId, api.nextStep(sessionId, { user_id: userId, question_id: question.id, ...input }));
    },
    [state, api, queueResponse],
  );

  const select = useCallback((optionIndex: number) => answerWith({ option_index: optionIndex }), [answerWith]);
  const submitText = useCallback((text: string) => answerWith({ text }), [answerWith]);

  // Phase 24 (spec D10). A board's words are separate questions: their answers
  // go in board order, one call after another, and only the last response is
  // queued — the ones between are the board's own next words.
  const submitBoard = useCallback(
    (firstAttempts: number[]) => {
      if (!state || state.answer !== null || state.question?.type !== 'matching') return;
      const { sessionId, userId, question } = state;
      const ids = question.board.question_ids.slice(question.board.question_ids.indexOf(question.id));
      setState((current) => (current ? { ...current, answer: { board: firstAttempts } } : current));
      queueResponse(
        sessionId,
        (async () => {
          let response: NextStepResponse | undefined;
          for (const [index, id] of ids.entries()) {
            response = await api.nextStep(sessionId, { user_id: userId, question_id: id, option_index: firstAttempts[index] });
          }
          if (!response) throw new Error('a board with no words to answer');
          return response;
        })(),
      );
    },
    [state, api, queueResponse],
  );

  // Phase 25 (spec D5). The server transcribes and judges, so the banner waits
  // for it. Not understood: the card stays, with what was heard. Understood:
  // the answer is the transcript, and the response's next step is queued.
  const submitSpeech = useCallback(
    (clip: Clip) => {
      if (!state || state.answer !== null || !state.question || state.speech.phase === 'checking') return;
      const { sessionId, userId, question } = state;
      // Only an attempt still being checked on this card may land: a card
      // answered meanwhile (show the answer, can't speak now) keeps its answer.
      const mine = (latest: QuizState | null) =>
        latest !== null &&
        latest.sessionId === sessionId &&
        latest.question?.id === question.id &&
        latest.answer === null &&
        latest.speech.phase === 'checking';
      setState((current) => (current ? { ...current, speech: { phase: 'checking' } } : current));
      void api
        .answerBySpeech(sessionId, { user_id: userId, question_id: question.id, mime_type: clip.mimeType, audio: clip.audio })
        .then((response) => {
          setState((latest) => {
            if (!latest || !mine(latest)) return latest;
            if (response.verdict === 'unheard' || !response.next) {
              return { ...latest, speech: { phase: 'unheard', heard: response.heard } };
            }
            return { ...latest, speech: IDLE_ATTEMPT, answer: { heard: response.heard, verdict: response.verdict }, queued: queuedFrom(response.next) };
          });
        })
        .catch(() => {
          setState((latest) => (latest && mine(latest) ? { ...latest, speech: { phase: 'failed' } } : latest));
        });
    },
    [state, api],
  );

  // A skip shows no banner: Continue is requested at once, so the next card
  // appears as soon as the server answers (spec D8).
  const pass = useCallback(
    (kind: 'skip' | 'show_answer') => {
      if (!state || state.answer !== null || !state.question || state.speech.phase === 'checking') return;
      const { sessionId, userId, question } = state;
      setState((current) =>
        current ? { ...current, answer: { pass: kind }, speech: IDLE_ATTEMPT, advanceRequested: kind === 'skip' } : current,
      );
      queueResponse(sessionId, api.nextStep(sessionId, { user_id: userId, question_id: question.id, pass: kind }));
    },
    [state, api, queueResponse],
  );

  const markSpeechFailed = useCallback(() => {
    setState((current) =>
      current && current.answer === null && current.speech.phase !== 'checking'
        ? { ...current, speech: { phase: 'failed' } }
        : current,
    );
  }, []);

  const retrySpeech = useCallback(() => {
    setState((current) => (current ? { ...current, speech: IDLE_ATTEMPT } : current));
  }, []);

  const stopSpeaking = useCallback((reason: 'chosen' | 'no_mic') => {
    setState((current) => (current && current.speakingOff === null && current.speech.phase !== 'checking' ? { ...current, speakingOff: reason, speech: IDLE_ATTEMPT } : current));
  }, []);

  // Spec D8: with speaking off, a read-aloud card is passed without being shown.
  useEffect(() => {
    if (state && passesUnseen(state.question, state.speakingOff, state.answer !== null)) pass('skip');
  }, [state, pass]);

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
        answer: null,
        selectedOption: null,
        answered: false,
        complete: false,
        correctCount: 0,
        missedQuestions: [],
        progress: [],
        sessionId: null,
        enter,
        select,
        submitText,
        submitBoard,
        speech: IDLE_ATTEMPT,
        speakingOff: null,
        submitSpeech,
        pass,
        retrySpeech,
        markSpeechFailed,
        stopSpeaking,
        next,
      };
    }
    return {
      hasSession: true,
      question: state.question,
      position: state.position,
      total: state.total,
      answer: state.answer,
      selectedOption: state.answer && 'option_index' in state.answer ? state.answer.option_index : null,
      answered: state.answer !== null,
      complete: state.complete,
      correctCount: state.correctCount,
      missedQuestions: state.missedQuestions,
      progress: state.progress,
      sessionId: state.sessionId,
      enter,
      select,
      submitText,
      submitBoard,
      speech: state.speech,
      speakingOff: state.speakingOff,
      submitSpeech,
      pass,
      retrySpeech,
      markSpeechFailed,
      stopSpeaking,
      next,
    };
  }, [state, enter, select, submitText, submitBoard, submitSpeech, pass, retrySpeech, markSpeechFailed, stopSpeaking, next]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return value;
}
