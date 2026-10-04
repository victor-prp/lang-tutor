import type {
  VocabularyEntryInput,
  VocabularyWord,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';
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

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { appendPage } from '@/vocabulary';

// Mirrors TranslationProvider: constructed at the composition root with the api
// client passed in (ADR 0002). The server is the single source of truth — no
// cross-screen cache; the list reloads on focus.
export type VocabularyStatus = 'idle' | 'loading' | 'ready' | 'error';

export type VocabularyValue = {
  words: VocabularyWord[];
  status: VocabularyStatus;
  hasMore: boolean;
  /** From the top: on focus, on pull-to-refresh, after an enrollment switch. */
  reload: () => void;
  /** The next page, if there is one and none is loading. */
  loadMore: () => void;
  loadWord: (lexemeId: string) => Promise<VocabularyWordDetail>;
  save: (entries: VocabularyEntryInput[]) => Promise<void>;
  unsave: (senseId: string) => Promise<void>;
};

const VocabularyContext = createContext<VocabularyValue | undefined>(undefined);

export function VocabularyProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const { active } = useCurrentUser();
  const [words, setWords] = useState<VocabularyWord[]>([]);
  const [status, setStatus] = useState<VocabularyStatus>('idle');
  const [cursor, setCursor] = useState<string | null>(null);
  // A reload bumps this; a page that lands for an older generation is dropped,
  // so a slow page 3 cannot append to a list that was reloaded meanwhile.
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (after: string | null, replace: boolean) => {
      if (!active) return;
      const mine = replace ? ++generation.current : generation.current;
      setStatus('loading');
      try {
        const page = await api.listVocabulary(active.id, after ? { cursor: after } : {});
        if (mine !== generation.current) return;
        setWords((loaded) => (replace ? page.items : appendPage(loaded, page.items)));
        setCursor(page.next_cursor);
        setStatus('ready');
      } catch {
        if (mine === generation.current) setStatus('error');
      }
    },
    [api, active],
  );

  // A switch of enrollment is another list.
  useEffect(() => {
    generation.current += 1;
    setWords([]);
    setCursor(null);
    setStatus('idle');
  }, [active]);

  // Stable identities, not inline arrows in the memo below. The list screen hands
  // `reload` to useFocusEffect and the drill-down puts `loadWord` in an effect's
  // dependencies; a new function on every render would re-run both on every
  // state change — a reload loop.
  const reload = useCallback(() => void fetchPage(null, true), [fetchPage]);
  const loadWord = useCallback(
    (lexemeId: string) => {
      if (!active) return Promise.reject(new Error('no active enrollment'));
      return api.vocabularyWord(active.id, lexemeId);
    },
    [api, active],
  );
  const save = useCallback(
    async (entries: VocabularyEntryInput[]) => {
      if (!active) return;
      await api.saveVocabulary(active.id, { entries });
    },
    [api, active],
  );
  const unsave = useCallback(
    async (senseId: string) => {
      if (!active) return;
      await api.unsaveVocabulary(active.id, senseId);
    },
    [api, active],
  );

  const value = useMemo<VocabularyValue>(
    () => ({
      words,
      status,
      hasMore: cursor !== null,
      reload,
      loadMore: () => {
        if (cursor !== null && status !== 'loading') void fetchPage(cursor, false);
      },
      loadWord,
      save,
      unsave,
    }),
    [words, status, cursor, fetchPage, reload, loadWord, save, unsave],
  );

  return <VocabularyContext.Provider value={value}>{children}</VocabularyContext.Provider>;
}

export function useVocabulary(): VocabularyValue {
  const value = useContext(VocabularyContext);
  if (!value) throw new Error('useVocabulary must be used inside a VocabularyProvider');
  return value;
}
