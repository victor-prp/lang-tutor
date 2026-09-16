import type { TranslationDirection, TranslationResponse } from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { ApiError, type ApiClient } from '@/api/client';

// Mirrors the SessionProvider shape: constructed at the composition root with
// the api client passed in, so nothing here reaches for a module-level
// singleton (ADR 0002).
export type TranslationStatus = 'idle' | 'loading' | 'answered' | 'empty' | 'error';

export type TranslationValue = {
  status: TranslationStatus;
  text: string;
  setText: (value: string) => void;
  result: TranslationResponse | undefined;
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
   * Swaps the direction by swapping the TEXT: the sense on screen moves into the
   * input, and that is what gets looked up, the other way round. A direction the
   * box does not agree with is not a state this screen can be in, which is the
   * whole point — the label describes the text that produced it, and the next
   * submit is the reverse lookup rather than a repeat of the first one.
   */
  flip: () => void;
  reset: () => void;
};

const TranslationContext = createContext<TranslationValue | undefined>(undefined);

export function TranslationProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const [status, setStatus] = useState<TranslationStatus>('idle');
  const [text, setText] = useState('');
  const [result, setResult] = useState<TranslationResponse | undefined>(undefined);
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);

  const run = useCallback(
    async (query: string, direction: TranslationDirection | undefined) => {
      const trimmed = query.trim();
      if (trimmed.length === 0 || trimmed.length > 100) return;

      setStatus('loading');
      setChosenIndex(null);
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
      chosenIndex,
      choose: (index: number) => setChosenIndex(index),
      submit: (override?: string) => void run(override ?? text, undefined),
      flip: () => {
        // The chosen sense if the learner has picked one, else the ranked first
        // — the card wearing the badge. A result with no senses is the `empty`
        // status, which renders no control at all, so the guard is for the type
        // rather than for anything a learner can reach.
        const sense = result?.senses[chosenIndex ?? 0];
        if (!result || !sense) return;
        // Both halves, exactly as the correction chips call both: `run` must not
        // read the `text` this render still holds. The direction travels
        // explicitly rather than being left to detection, so the reverse lookup
        // is the reverse lookup even when the translation carries no Hebrew for
        // detection to find — a proper noun comes back spelled the same way.
        setText(sense.translation);
        void run(sense.translation, result.direction === 'he_en' ? 'en_he' : 'he_en');
      },
      reset: () => {
        setStatus('idle');
        setText('');
        setResult(undefined);
        setChosenIndex(null);
      },
    }),
    [status, text, result, chosenIndex, run],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): TranslationValue {
  const value = useContext(TranslationContext);
  if (!value) throw new Error('useTranslation must be used inside a TranslationProvider');
  return value;
}
