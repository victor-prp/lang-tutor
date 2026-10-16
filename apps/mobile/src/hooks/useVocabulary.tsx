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

/** How the list is asked for: optionally, one level. */
export type VocabularyQuery = { level: number | null };
const DEFAULT_QUERY: VocabularyQuery = { level: null };

export type VocabularyValue = {
  words: VocabularyWord[];
  status: VocabularyStatus;
  hasMore: boolean;
  query: VocabularyQuery;
  /** A new filter: reloads from the first page. */
  setQuery: (query: VocabularyQuery) => void;
  /** From the top: on focus, on pull-to-refresh, after an enrollment switch. */
  reload: () => void;
  /** The next page, if there is one and none is loading. */
  loadMore: () => void;
  loadWord: (lemma: string) => Promise<VocabularyWordDetail>;
  save: (entries: VocabularyEntryInput[]) => Promise<void>;
  unsave: (glossId: string) => Promise<void>;
  /** Phase 58 (spec D4), 58b (R2). Every word the current filter shows leaves the
   *  list, every word on "all"; resolves once the list has reloaded. Throws when the
   *  server refused, so the screen can say so. */
  removeShown: () => Promise<void>;
};

const VocabularyContext = createContext<VocabularyValue | undefined>(undefined);

export function VocabularyProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const { active, user } = useCurrentUser();
  const [words, setWords] = useState<VocabularyWord[]>([]);
  const [status, setStatus] = useState<VocabularyStatus>('idle');
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQueryState] = useState<VocabularyQuery>(DEFAULT_QUERY);
  // Read by reload and loadMore so their identities stay stable across query
  // changes; the list screen hands reload to useFocusEffect.
  const queryRef = useRef(query);
  // A reload bumps this; a page that lands for an older generation is dropped,
  // so a slow page 3 cannot append to a list that was reloaded meanwhile.
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (after: string | null, replace: boolean, asked: VocabularyQuery) => {
      if (!active) return;
      const mine = replace ? ++generation.current : generation.current;
      setStatus('loading');
      try {
        const page = await api.listVocabulary(active.id, {
          ...(after ? { cursor: after } : {}),
          ...(asked.level !== null ? { level: asked.level } : {}),
        });
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
    queryRef.current = DEFAULT_QUERY;
    setQueryState(DEFAULT_QUERY);
    setWords([]);
    setCursor(null);
    setStatus('idle');
  }, [active]);

  // Stable identities, not inline arrows in the memo below. The list screen hands
  // `reload` to useFocusEffect and the drill-down puts `loadWord` in an effect's
  // dependencies; a new function on every render would re-run both on every
  // state change — a reload loop.
  const reload = useCallback(() => void fetchPage(null, true, queryRef.current), [fetchPage]);
  const setQuery = useCallback(
    (next: VocabularyQuery) => {
      queryRef.current = next;
      setQueryState(next);
      // The old cursor belongs to the old query: with it kept, a failed first page
      // would leave loadMore continuing the old list under the new query.
      setCursor(null);
      void fetchPage(null, true, next);
    },
    [fetchPage],
  );
  const loadWord = useCallback(
    (lemma: string) => {
      if (!active) return Promise.reject(new Error('no active enrollment'));
      return api.vocabularyWord(active.id, lemma);
    },
    [api, active],
  );
  const save = useCallback(
    async (entries: VocabularyEntryInput[]) => {
      if (!active || !user) return;
      await api.saveVocabulary(active.id, { entries });
    },
    [api, active, user],
  );
  const unsave = useCallback(
    async (glossId: string) => {
      if (!active || !user) return;
      await api.unsaveVocabulary(active.id, glossId);
    },
    [api, active, user],
  );

  const removeShown = useCallback(async () => {
    if (!active || !user) return;
    const asked = queryRef.current;
    const mine = generation.current;
    await api.removeVocabularyWords(active.id, asked.level === null ? { all: true } : { level: asked.level });
    // A switch of enrollment or filter meanwhile bumped the generation and loads its
    // own list: reloading this one would put the old list under the new title.
    if (mine !== generation.current) return;
    await fetchPage(null, true, asked);
  }, [api, active, user, fetchPage]);

  const value = useMemo<VocabularyValue>(
    () => ({
      words,
      status,
      hasMore: cursor !== null,
      query,
      setQuery,
      reload,
      loadMore: () => {
        if (cursor !== null && status !== 'loading') void fetchPage(cursor, false, queryRef.current);
      },
      loadWord,
      save,
      unsave,
      removeShown,
    }),
    [words, status, cursor, query, setQuery, fetchPage, reload, loadWord, save, unsave, removeShown],
  );

  return <VocabularyContext.Provider value={value}>{children}</VocabularyContext.Provider>;
}

export function useVocabulary(): VocabularyValue {
  const value = useContext(VocabularyContext);
  if (!value) throw new Error('useVocabulary must be used inside a VocabularyProvider');
  return value;
}
