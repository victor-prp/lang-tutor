import type { TranslationDirection, TranslationResponse } from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { ApiError, type ApiClient } from '@/api/client';
import { directionFor, oppositeOf, type DirectionPin } from '@/translationDirection';

// Mirrors the SessionProvider shape: constructed at the composition root with
// the api client passed in, so nothing here reaches for a module-level
// singleton (ADR 0002).
export type TranslationStatus = 'idle' | 'loading' | 'answered' | 'empty' | 'error';

export type TranslationValue = {
  status: TranslationStatus;
  text: string;
  setText: (value: string) => void;
  result: TranslationResponse | undefined;
  revealed: boolean;
  reveal: () => void;
  chosenIndex: number | null;
  choose: (index: number) => void;
  /**
   * `override` exists for the correction banner's alternative chips. `submit()`
   * closes over the provider's `text` state, so `setText(alt)` followed by a bare
   * `submit()` would re-run the TYPED string: the closure captured the old value
   * and the state update has not landed yet. The handler calls both, so the input
   * field agrees with the results it is showing.
   */
  submit: (override?: string) => void;
  /**
   * Re-runs the current text in the other direction, and makes that choice
   * stick: every later lookup of the same string sends it too, so the direction
   * on screen is the direction the next request will carry. Typing something
   * else returns to detection — see `DirectionPin`.
   */
  flip: () => void;
  reset: () => void;
};

const TranslationContext = createContext<TranslationValue | undefined>(undefined);

export function TranslationProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const [status, setStatus] = useState<TranslationStatus>('idle');
  const [text, setText] = useState('');
  const [result, setResult] = useState<TranslationResponse | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  const [pin, setPin] = useState<DirectionPin | undefined>(undefined);

  const run = useCallback(
    async (query: string, direction: TranslationDirection | undefined) => {
      const trimmed = query.trim();
      if (trimmed.length === 0 || trimmed.length > 100) return;

      setStatus('loading');
      setRevealed(false);
      setChosenIndex(null);
      // Recorded here rather than in `flip`, so that the one place a direction
      // is chosen is also the one place it is remembered: every path that names
      // a direction pins it, and every path that leaves it to detection clears
      // whatever the last one pinned.
      setPin(direction ? { form: trimmed, direction } : undefined);
      try {
        const response = await api.translate(
          direction ? { text: trimmed, direction } : { text: trimmed },
        );
        setResult(response);
        // An empty sense list is a successful answer about the input, not a
        // failure — a distinct state, not the error state.
        setStatus(response.senses.length === 0 ? 'empty' : 'answered');
      } catch (error) {
        // 400 cannot happen here (the field is validated before submit), so
        // every failure reads the same to the learner. ApiError carries the
        // status for a future distinction.
        void (error instanceof ApiError);
        setResult(undefined);
        setStatus('error');
      }
    },
    [api],
  );

  const value = useMemo<TranslationValue>(
    () => ({
      status,
      text,
      setText,
      result,
      revealed,
      chosenIndex,
      reveal: () => setRevealed(true),
      choose: (index: number) => setChosenIndex(index),
      // A submit re-sends a flip the learner already made for this exact string,
      // instead of dropping it and letting the server detect all over again. An
      // alternative chip's `override` is a different string, so it detects — the
      // pin belongs to the form it was chosen for, not to the screen.
      submit: (override?: string) => {
        const query = override ?? text;
        void run(query, directionFor(query, pin));
      },
      // Re-requests with the opposite direction made explicit, which is what
      // makes a wrong detection recoverable rather than a dead end.
      flip: () => void run(text, oppositeOf(result?.direction ?? 'en_he')),
      reset: () => {
        setStatus('idle');
        setText('');
        setResult(undefined);
        setRevealed(false);
        setChosenIndex(null);
        setPin(undefined);
      },
    }),
    [status, text, result, revealed, chosenIndex, pin, run],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): TranslationValue {
  const value = useContext(TranslationContext);
  if (!value) throw new Error('useTranslation must be used inside a TranslationProvider');
  return value;
}
