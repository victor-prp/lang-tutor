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
  revealed: boolean;
  reveal: () => void;
  chosenIndex: number | null;
  choose: (index: number) => void;
  submit: () => void;
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

  const run = useCallback(
    async (query: string, direction: TranslationDirection | undefined) => {
      const trimmed = query.trim();
      if (trimmed.length === 0 || trimmed.length > 100) return;

      setStatus('loading');
      setRevealed(false);
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
      revealed,
      chosenIndex,
      reveal: () => setRevealed(true),
      choose: (index: number) => setChosenIndex(index),
      submit: () => void run(text, undefined),
      // Re-requests with the opposite direction made explicit, which is what
      // makes a wrong detection recoverable rather than a dead end.
      flip: () => void run(text, result?.direction === 'he_en' ? 'en_he' : 'he_en'),
      reset: () => {
        setStatus('idle');
        setText('');
        setResult(undefined);
        setRevealed(false);
        setChosenIndex(null);
      },
    }),
    [status, text, result, revealed, chosenIndex, run],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): TranslationValue {
  const value = useContext(TranslationContext);
  if (!value) throw new Error('useTranslation must be used inside a TranslationProvider');
  return value;
}
