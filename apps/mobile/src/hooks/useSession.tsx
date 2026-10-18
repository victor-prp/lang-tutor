import type { MissedQuestion, NextStepResponse, PendingRetry, Question, SessionProgressItem } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
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
import { checksFit, type CardAnswer } from '@/feedback';
import type { Clip } from '@/recording';
import {
  answeredState,
  answerRoute,
  applyQueued,
  continued,
  enteredState,
  helpedFor,
  tappedFor,
  wordTappedState,
  helpPressedState,
  landed,
  nextStepRequest,
  queuedFrom,
  resumed,
  retried,
  retypeCheckedState,
  retypeTypingState,
  seenState,
  settle,
  type QuizState,
  type Settled,
} from '@/quiz';
import type { Retype } from '@/retype';
import { canJudge, judgedAnswer, type JudgeAttempt } from '@/judging';
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
  /** Phase 23. Answers a typed card. An empty text is "show me the answer".
   *  Phase 38 (spec D4): a typed gap says whether its hint was opened. Phase 55
   *  (spec D6): the tiles card says whether it was helped; phase 56 (spec D5):
   *  every other card that takes help is helped by the count below. */
  submitText: (text: string, card?: { hintOpened?: boolean; helped?: boolean }) => void;
  /** Phase 56 (spec D5). How many characters help has revealed on the card on
   *  screen, its second try and "can't speak now" included; 0 on a new card. */
  help: number;
  /** Help pressed: one more character. Every answer to the card then says it was helped.
   *  Phase 63 (spec D3): on a typed card, with the text typed, which the press reads. */
  pressHelp: (typed?: string) => void;
  /** Phase 63 (spec D3). The typed text the last press marked, from its first wrong character. */
  helpMarks: { text: string; from: number } | null;
  /** Phase 59 (spec D3, D5). The sentence translation's words tapped, by index.
   *  Phase 62 (spec D3): any tapped sentence's. */
  tapped: number[];
  /** A word of the sentence tapped: its index, or `'mark'` on a card with no word map. */
  pressWord: (tap: number | 'mark') => void;
  /** Phase 24. Answers a board: each word's first-tried meaning, in board order. */
  /** Phase 63 (spec D8): with the words help matched, in the same order. */
  submitBoard: (firstAttempts: number[], helped?: boolean[]) => void;
  /** Phase 25. The speaking card's attempt that has recorded nothing yet. */
  speech: SpeechAttempt;
  /** Phase 25 (spec D8). Off for the rest of the session, and why. */
  speakingOff: SpeakingOff;
  /** Sends a recorded clip for the speaking card on screen. */
  submitSpeech: (clip: Clip) => void;
  /** Answers a speaking card without audio: skip, or show the answer. */
  pass: (kind: 'skip' | 'show_answer') => void;
  /** Phase 54 (spec D1, D6). The meet card tapped through: answered with `seen`,
   *  and the next card at once, with no banner. */
  seen: () => void;
  /** The recorder could not start: the card shows the "couldn't check" notice. */
  markSpeechFailed: () => void;
  /** Back to a fresh attempt after one that recorded nothing. */
  retrySpeech: () => void;
  /** "Can't speak now", or a refused microphone. */
  stopSpeaking: (reason: 'chosen' | 'no_mic') => void;
  /** Phase 27 (spec D13). A judged card's check: idle, in flight, or failed. */
  judging: JudgeAttempt;
  /** Sends a meaning card's text to the server's judge. */
  submitJudged: (text: string) => void;
  /** Phase 34 (spec D9). The card on screen is held for its second try: the
   *  first answer and which line to show. Null on every other card. Every
   *  answer above sends `retry: true` while it is set. */
  retry: PendingRetry | null;
  /** Phase 55 (spec D7). The retype after a wrong or nearly right first typed
   *  translation; null on every other card. While it is open there is no
   *  banner, and Continue does nothing. */
  retype: Retype | null;
  /** The first character of a retype: the right answer hides. */
  retypeTyping: () => void;
  /** Checks a retype on the phone. Nothing is sent: the grade is the first answer's. */
  retypeChecked: (text: string) => void;
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
      // Phase 55 (spec D7): with no retype, which is never sent, so a session
      // left mid-retype resumes on the card after it.
      setState(enteredState(sessionId));
      void (async () => {
        try {
          const currentUser = userRef.current;
          // Unreachable in practice (home redirects to /sign-in when signed out),
          // but a session with no learner must fail loudly. The server knows who
          // is answering from the session (phase 29), so no id is sent.
          if (!currentUser) throw new Error('cannot enter a session with no learner');
          const view = await api.getSession(sessionId);
          if (view.status !== 'ready' || !view.question) {
            throw new Error(`session ${sessionId} is ${view.status}`);
          }
          // Phase 34 (spec D9): a card left pending opens on its second try.
          setState((latest) => (latest?.sessionId === sessionId ? resumed(latest, view) : latest));
        } catch {
          if (stateRef.current?.sessionId === sessionId) handleApiFailure();
        }
      })();
    },
    [api],
  );

  // What a next-step response becomes once it lands: queued for Continue, or
  // applied at once when Continue was already tapped. Shared by a single
  // answer and a board's last one. Phase 34 (spec D9, ruling R16): an answer
  // that resolved a hold it met (see settle) keeps that hold, so its banner is
  // a second try's.
  const queueResponse = useCallback((sessionId: string, call: Promise<Settled>) => {
    void call
      .then(({ next, met }) => {
        const queued = queuedFrom(next);
        setState((latest) => {
          if (!latest || latest.sessionId !== sessionId) return latest;
          const current = met === null ? latest : { ...latest, retry: met };
          return current.advanceRequested ? applyQueued(current, queued) : { ...current, queued };
        });
      })
      .catch(() => {
        // The session may have been abandoned while this was in flight; only
        // the session it belongs to may alert. stateRef, not the stale closure.
        if (stateRef.current?.sessionId === sessionId) handleApiFailure();
      });
  }, []);

  // Phase 27 (spec D13), widened in phase 34. An answer whose banner waits for
  // the server: a judged card's, and a typed card's on the `server` route
  // (answerRoute). In flight, the card is locked; failed, it keeps its text for
  // "try again", which sends the same request. The response lands by `landed`:
  // a hold opens the second try at once, with no banner; anything else answers
  // the card and queues the next step, as a judged card always did.
  const checkWith = useCallback(
    (sessionId: string, questionId: string, call: Promise<Settled>) => {
      const mine = (latest: QuizState | null) =>
        latest !== null && latest.sessionId === sessionId && latest.question?.id === questionId && latest.answer === null && latest.judging === 'checking';
      setState((current) => (current ? { ...current, judging: 'checking' } : current));
      void call
        .then(({ answer, next, met }) => {
          setState((latest) => (latest && mine(latest) ? landed(latest, answer, next, met) : latest));
        })
        .catch(() => {
          setState((latest) => (latest && mine(latest) ? { ...latest, judging: 'failed' } : latest));
        });
    },
    [],
  );

  // Reads `state` directly (and depends on it) rather than going through
  // setState's updater-function form, because the updater form is invoked
  // twice by React Strict Mode to catch exactly the kind of impurity that a
  // real network call inside it would be — nextStep must fire exactly once
  // per answer, so it stays outside any updater entirely.
  //
  // Phase 23: one path for a chosen option and a typed text. The guard on
  // `state.answer` is what makes a second tap, or Return then Check, a no-op.
  const answerWith = useCallback(
    (given: { option_index: number } | { text: string; helped?: boolean }, hintOpened?: boolean) => {
      if (!state || state.answer !== null || !state.question || state.judging === 'checking') return;
      const { sessionId, question, retry } = state;
      // Phase 56 (spec D5): a text answer says whether the card was helped.
      // Phase 63 (spec D10): and so does a choice.
      const helped = helpedFor(question, state.help, 'text' in given ? given : undefined, state.helpPressed);
      const input =
        'text' in given
          ? helped === undefined
            ? { text: given.text }
            : { text: given.text, helped }
          : helped === undefined
            ? { option_index: given.option_index }
            : { option_index: given.option_index, helped };
      // Phase 34 (spec D9): the second try at a held card carries retry: true,
      // and an answer meeting a hold it could not have opened goes again as one.
      // Phase 62 (spec D6): and the words tapped on its sentence.
      const tapped = tappedFor(question, state.tapped);
      const call = settle(question, retry, (as) =>
        api.nextStep(sessionId, nextStepRequest(question.id, input, as, hintOpened, checksFit(question, input), tapped)).then((next) => ({ answer: input, next })),
      );

      // Phase 34 (spec D9). Another accepted word, or any answer after a failed
      // check, waits for the server before its banner (answerRoute).
      if (answerRoute(state, question, input) === 'server') {
        checkWith(sessionId, question.id, call);
        return;
      }

      // Phase 55 (spec D7): a wrong or nearly right first typed translation
      // opens its retype here, before any banner; the response is queued as ever.
      setState((current) => (current ? answeredState(current, input) : current));

      // Fired in the background: the verdict is already visible to the learner
      // the moment this returns (feedbackFor runs the server's own evaluate),
      // so this call only has to register the answer server-side and fetch
      // what's next before Continue is tapped.
      queueResponse(sessionId, call);
    },
    [state, api, queueResponse, checkWith],
  );

  const select = useCallback((optionIndex: number) => answerWith({ option_index: optionIndex }), [answerWith]);
  const submitText = useCallback(
    (text: string, { hintOpened, helped }: { hintOpened?: boolean; helped?: boolean } = {}) =>
      answerWith(helped === undefined ? { text } : { text, helped }, hintOpened),
    [answerWith],
  );

  // Phase 24 (spec D10). A board's words are separate questions: their answers
  // go in board order, one call after another, and only the last response is
  // queued — the ones between are the board's own next words.
  const submitBoard = useCallback(
    (firstAttempts: number[], helped: boolean[] = []) => {
      if (!state || state.answer !== null || state.question?.type !== 'matching') return;
      const { sessionId, question } = state;
      const ids = question.board.question_ids.slice(question.board.question_ids.indexOf(question.id));
      // Phase 63 (spec D8, D10): each word says whether help matched it.
      const answer = { board: firstAttempts, helped: firstAttempts.map((_, index) => helped[index] === true) };
      setState((current) => (current ? { ...current, answer } : current));
      queueResponse(
        sessionId,
        (async () => {
          let response: NextStepResponse | undefined;
          for (const [index, id] of ids.entries()) {
            response = await api.nextStep(sessionId, { question_id: id, option_index: firstAttempts[index], helped: answer.helped[index] });
          }
          if (!response) throw new Error('a board with no words to answer');
          return { answer, next: response, met: null };
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
      const { sessionId, question, retry } = state;
      // Phase 56 (spec D5): a say the translation said with help says so.
      const helped = helpedFor(question, state.help, undefined, state.helpPressed);
      const helps = helped === undefined ? {} : { helped };
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
        .answerBySpeech(sessionId, retried({ question_id: question.id, mime_type: clip.mimeType, audio: clip.audio, ...helps }, retry))
        .then((response) => {
          setState((latest) => {
            if (!latest || !mine(latest)) return latest;
            if (response.verdict === 'unheard' || !response.next) {
              return { ...latest, speech: { phase: 'unheard', heard: response.heard } };
            }
            // Phase 34 (spec D9): another right word holds the card, and the
            // microphone is offered again.
            return landed(latest, { heard: response.heard, verdict: response.verdict, ...helps }, response.next, null);
          });
        })
        .catch(() => {
          setState((latest) => (latest && mine(latest) ? { ...latest, speech: { phase: 'failed' } } : latest));
        });
    },
    [state, api],
  );

  // Phase 27 (spec D13). The server judges, so the banner waits for it. A
  // failed check keeps the card, and its text, for another try. Phase 34: an
  // answer in other words, or another sense, holds the card for a second try.
  const submitJudged = useCallback(
    (text: string) => {
      if (!state || !state.question || !canJudge(state.judging, state.answer !== null)) return;
      const { sessionId, question, retry } = state;
      // Phase 56 (spec D5): a judged card says whether it was helped.
      const helped = helpedFor(question, state.help, undefined, state.helpPressed);
      const helps = helped === undefined ? {} : { helped };
      // Phase 59 (spec D5): and which of its words were tapped.
      const tapped = tappedFor(question, state.tapped);
      const taps = tapped === undefined ? {} : { tapped };
      checkWith(
        sessionId,
        question.id,
        settle(question, retry, (as) =>
          api
            .judgeAnswer(sessionId, retried({ question_id: question.id, text, ...helps, ...taps }, as))
            .then((response) => ({ answer: judgedAnswer(text, response, helped), next: response.next })),
        ),
      );
    },
    [state, api, checkWith],
  );

  // A skip shows no banner: Continue is requested at once, so the next card
  // appears as soon as the server answers (spec D8).
  const pass = useCallback(
    (kind: 'skip' | 'show_answer') => {
      if (!state || state.answer !== null || !state.question || state.speech.phase === 'checking') return;
      const { sessionId, question, retry } = state;
      setState((current) =>
        current ? { ...current, answer: { pass: kind }, speech: IDLE_ATTEMPT, advanceRequested: kind === 'skip' } : current,
      );
      // Phase 56 (spec D5): given up after help, the pass says so.
      const helped = helpedFor(question, state.help, undefined, state.helpPressed);
      const passed = helped === undefined ? { pass: kind } : { pass: kind, helped };
      // Phase 34 (spec D9): on a second try, a skip is sent as the give-up.
      queueResponse(
        sessionId,
        settle(question, retry, (as) =>
          api.nextStep(sessionId, nextStepRequest(question.id, passed, as)).then((next) => ({ answer: { pass: kind }, next })),
        ),
      );
    },
    [state, api, queueResponse],
  );

  // Phase 54 (spec D1, D6). A meet card asked nothing, so it has no banner:
  // like a skip, Continue is requested at once and the next card appears as
  // soon as the server answers. It is never held for a second try, so no settle.
  const seen = useCallback(() => {
    if (!state || state.answer !== null || state.question?.type !== 'meet') return;
    const { sessionId, question } = state;
    setState((current) => (current ? seenState(current) : current));
    queueResponse(
      sessionId,
      api.nextStep(sessionId, nextStepRequest(question.id, { seen: true }, null)).then((next) => ({ answer: { seen: true }, next, met: null })),
    );
  }, [state, api, queueResponse]);

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

  // Phase 55 (spec D7): an open retype ignores Continue (continued).
  const next = useCallback(() => {
    setState((current) => (current ? continued(current) : current));
  }, []);

  // Phase 55 (spec D7). The retype is the phone's alone: nothing is sent.
  const retypeTyping = useCallback(() => {
    setState((current) => (current ? retypeTypingState(current) : current));
  }, []);

  const retypeChecked = useCallback((text: string) => {
    setState((current) => (current ? retypeCheckedState(current, text) : current));
  }, []);

  // Phase 56 (spec D5). The phone's alone until the answer says it.
  const pressHelp = useCallback((typed?: string) => {
    setState((current) => (current ? helpPressedState(current, typed) : current));
  }, []);

  // Phase 59 (spec D3). The phone's alone until the answer carries it.
  const pressWord = useCallback((tap: number | 'mark') => {
    setState((current) => (current ? wordTappedState(current, tap) : current));
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
        help: 0,
        pressHelp,
        helpMarks: null,
        tapped: [],
        pressWord,
        submitBoard,
        speech: IDLE_ATTEMPT,
        speakingOff: null,
        submitSpeech,
        pass,
        seen,
        retrySpeech,
        markSpeechFailed,
        stopSpeaking,
        judging: 'idle',
        submitJudged,
        retry: null,
        retype: null,
        retypeTyping,
        retypeChecked,
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
      help: state.help,
      pressHelp,
      helpMarks: state.helpMarks,
      tapped: state.tapped,
      pressWord,
      submitBoard,
      speech: state.speech,
      speakingOff: state.speakingOff,
      submitSpeech,
      pass,
      seen,
      retrySpeech,
      markSpeechFailed,
      stopSpeaking,
      judging: state.judging,
      submitJudged,
      retry: state.retry,
      retype: state.retype,
      retypeTyping,
      retypeChecked,
      next,
    };
  }, [state, enter, select, submitText, pressHelp, pressWord, submitBoard, submitSpeech, pass, seen, retrySpeech, markSpeechFailed, stopSpeaking, submitJudged, retypeTyping, retypeChecked, next]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return value;
}
