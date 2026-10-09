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
import {
  addableStateOf,
  lookupEnrollmentId,
  toggleIntent,
  canSaveAll as canSaveAllOf,
  savedStateOf,
  toggleOptimistically,
  topSense,
  unsavedEntries,
  withSaved,
  type SavedState,
} from '@/vocabulary';

// Mirrors the SessionProvider shape: constructed at the composition root with
// the api client passed in, so nothing here reaches for a module-level
// singleton (ADR 0002).
export type TranslationStatus = 'idle' | 'loading' | 'answered' | 'empty' | 'error';

export type TranslationValue = {
  status: TranslationStatus;
  text: string;
  setText: (value: string) => void;
  result: TranslationResponse | undefined;
  /** sense_id → saved, for the senses that can be saved here (see savedStateOf). */
  saved: SavedState;
  /** Senses with a save or unsave in flight; their toggle is disabled, so a double
   *  tap cannot race a save against an unsave. */
  pending: Record<string, true>;
  /** The last toggle failed and was reverted. Cleared by the next toggle or lookup. */
  saveFailed: boolean;
  toggleSave: (senseId: string) => void;
  saveAll: () => void;
  canSaveAll: boolean;
  /** 'tutor' on a student's list: the cards add and never remove. */
  mode: 'learner' | 'tutor';
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

/** Phase 28 (spec D10). The list a lookup works on. Without one the provider uses
 *  the user's own active enrollment in learner mode; the student's words screen
 *  nests a provider on a student's enrollment in tutor mode. */
export type LookupList = {
  enrollment: { id: string; source_language: string; target_language: string };
  mode: 'learner' | 'tutor';
};

export function TranslationProvider({
  api,
  list,
  children,
}: {
  api: ApiClient;
  list?: LookupList;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<TranslationStatus>('idle');
  const [text, setText] = useState('');
  const [result, setResult] = useState<TranslationResponse | undefined>(undefined);
  const [saved, setSaved] = useState<SavedState>({});
  const [pending, setPending] = useState<Record<string, true>>({});
  const [saveFailed, setSaveFailed] = useState(false);
  const { active, user } = useCurrentUser();
  const effective = useMemo<LookupList | null>(
    () => list ?? (active ? { enrollment: active, mode: 'learner' } : null),
    [list, active],
  );
  const enrollment = effective?.enrollment;
  const [direction, setDirection] = useState<LookupDirection | null>(
    enrollment ? lookupDirection(enrollment) : null,
  );

  // A switch of enrollment is a new pair: start over on its target → source.
  useEffect(() => {
    setDirection(enrollment ? lookupDirection(enrollment) : null);
    setStatus('idle');
    setText('');
    setResult(undefined);
    setSaved({});
    setPending({});
    setSaveFailed(false);
  }, [effective?.enrollment.id]);

  const run = useCallback(
    async (query: string, along: LookupDirection | null) => {
      const trimmed = query.trim();
      if (!along || trimmed.length === 0 || trimmed.length > 100) return;
      const mode = effective?.mode ?? 'learner';

      setStatus('loading');
      setSaved({});
      setPending({});
      setSaveFailed(false);
      try {
        const response = await api.translate({
          text: trimmed,
          from: along.from,
          to: along.to,
          // Phase 18. The server marks `saved` for a target-language lookup and
          // nothing else; the client never decides which senses are saveable.
          // A tutor's lookup sends none: it must not read the student's list.
          ...(effective ? lookupEnrollmentId(mode, effective.enrollment.id) : {}),
        });
        setResult(response);
        setSaved(
          effective && mode === 'tutor'
            ? addableStateOf(response.senses, response.from, effective.enrollment.target_language)
            : savedStateOf(response.senses),
        );
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
    [api, effective],
  );

  // Optimistic: flip first, revert on failure (toggleOptimistically). `pending`
  // keeps one request per sense in flight.
  const send = useCallback(
    async (entries: { sense_id: string; variant_id: string }[], next: boolean) => {
      if (!effective || !user || entries.length === 0) return;
      const listId = effective.enrollment.id;
      const ids = entries.map((entry) => entry.sense_id);
      setSaveFailed(false);
      const ok = await toggleOptimistically({
        next,
        apply: (value) => setSaved((current) => withSaved(current, ids, value)),
        inFlight: (inFlight) =>
          setPending((current) => {
            const rest = { ...current };
            for (const id of ids) {
              if (inFlight) rest[id] = true;
              else delete rest[id];
            }
            return rest;
          }),
        request: () =>
          next
            ? api.saveVocabulary(listId, { entries })
            : api.unsaveVocabulary(listId, ids[0]),
      });
      setSaveFailed(!ok);
    },
    [api, effective, user],
  );

  const value = useMemo<TranslationValue>(
    () => ({
      status,
      text,
      setText,
      result,
      saved,
      pending,
      saveFailed,
      mode: effective?.mode ?? 'learner',
      canSaveAll: result ? canSaveAllOf(result.senses, saved) : false,
      toggleSave: (senseId: string) => {
        const sense = result?.senses.find((s) => s.sense_id === senseId);
        if (!sense?.variant_id || saved[senseId] === undefined || pending[senseId]) return;
        // A tutor adds and never removes (spec D10): an added card does nothing.
        const intent = toggleIntent(effective?.mode ?? 'learner', saved[senseId]);
        if (intent === 'none') return;
        void send([{ sense_id: senseId, variant_id: sense.variant_id }], intent === 'save');
      },
      saveAll: () => {
        if (!result) return;
        void send(
          unsavedEntries(result.senses, saved).filter((entry) => !pending[entry.sense_id]),
          true,
        );
      },
      direction,
      submit: (override?: string) => void run(override ?? text, direction),
      flip: () => {
        if (!direction) return;
        const next = flipped(direction);
        setDirection(next);
        // The top-ranked sense: the card wearing the badge.
        const sense = topSense(result?.senses ?? []);
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
        setSaved({});
        setPending({});
        setSaveFailed(false);
      },
    }),
    [status, text, result, saved, pending, saveFailed, send, direction, run, effective],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): TranslationValue {
  const value = useContext(TranslationContext);
  if (!value) throw new Error('useTranslation must be used inside a TranslationProvider');
  return value;
}
