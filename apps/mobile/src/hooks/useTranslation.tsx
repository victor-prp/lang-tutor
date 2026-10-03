import type { TranslationResponse } from '@lang-tutor/core/api';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiError, type ApiClient } from '@/api/client';
import { flipped, lookupDirection, type LookupDirection } from '@/enrollments';
import { useCurrentUser } from '@/hooks/useCurrentUser';

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
  /** The lookup's direction; null only with no active enrollment. */
  direction: LookupDirection | null;
  /**
   * Swaps the direction. When a sense is on screen it also moves into the box and
   * is looked up the other way round, so the label always describes the text that
   * produced the results; with nothing on screen only the direction changes.
   */
  flip: () => void;
  /**
   * The `wrong_direction` answer's one-tap fix: the same text, the other way
   * round. Distinct from `flip`, which moves a SHOWN translation into the box —
   * here there is none, and the typed text is what was meant.
   */
  flipAndRetry: () => void;
  reset: () => void;
};

const TranslationContext = createContext<TranslationValue | undefined>(undefined);

export function TranslationProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const [status, setStatus] = useState<TranslationStatus>('idle');
  const [text, setText] = useState('');
  const [result, setResult] = useState<TranslationResponse | undefined>(undefined);
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  const { active } = useCurrentUser();
  const [direction, setDirection] = useState<LookupDirection | null>(
    active ? lookupDirection(active) : null,
  );

  // A switch of enrollment is a new pair: start over on its target → source.
  useEffect(() => {
    setDirection(active ? lookupDirection(active) : null);
    setStatus('idle');
    setText('');
    setResult(undefined);
    setChosenIndex(null);
  }, [active]);

  const run = useCallback(
    async (query: string, along: LookupDirection | null) => {
      const trimmed = query.trim();
      if (!along || trimmed.length === 0 || trimmed.length > 100) return;

      setStatus('loading');
      setChosenIndex(null);
      try {
        const response = await api.translate({ text: trimmed, from: along.from, to: along.to });
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
      direction,
      submit: (override?: string) => void run(override ?? text, direction),
      flip: () => {
        if (!direction) return;
        const next = flipped(direction);
        setDirection(next);
        // The chosen sense if the learner has picked one, else the ranked first
        // — the card wearing the badge.
        const sense = result?.senses[chosenIndex ?? 0];
        if (result && sense) {
          // Both halves, exactly as the correction chips call both: `run` must
          // not read the `text` this render still holds. The direction travels
          // explicitly, so the reverse lookup is the reverse lookup even when
          // the translation is spelled the same way in both languages — a
          // proper noun comes back unchanged.
          setText(sense.translation);
          void run(sense.translation, next);
        }
      },
      flipAndRetry: () => {
        if (!direction) return;
        const next = flipped(direction);
        setDirection(next);
        void run(text, next);
      },
      reset: () => {
        setStatus('idle');
        setText('');
        setResult(undefined);
        setChosenIndex(null);
      },
    }),
    [status, text, result, chosenIndex, direction, run],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): TranslationValue {
  const value = useContext(TranslationContext);
  if (!value) throw new Error('useTranslation must be used inside a TranslationProvider');
  return value;
}
