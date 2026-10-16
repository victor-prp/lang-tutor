import { ApiError } from '@/api/client';
import type { QuestionTypesResponse, SessionView } from '@lang-tutor/core/api';
import type { QuestionType } from '@lang-tutor/core/domain';

/** Phase 61 (spec D6). What a tester starts with: every type the word can have. */
export function initialSelection(types: QuestionTypesResponse['types']): Set<QuestionType> {
  return new Set(types.filter((entry) => entry.available).map((entry) => entry.type));
}

/** One type ticked or unticked, as a new set. */
export function toggled(chosen: ReadonlySet<QuestionType>, type: QuestionType): Set<QuestionType> {
  const next = new Set(chosen);
  if (next.has(type)) next.delete(type);
  else next.add(type);
  return next;
}

export type AfterPreparing =
  | { next: 'wait' }
  | { next: 'enter' }
  | { next: 'show_skipped'; skipped: QuestionType[] }
  | { next: 'failed'; skipped: QuestionType[] };

/**
 * Phase 61 (spec D5, D6). What the screen does with the session it is polling: wait
 * while it prepares; enter it when ready, after showing the types no card was
 * generated for, if any; and say it failed, with those types, otherwise.
 */
export function afterPreparing(view: Pick<SessionView, 'status' | 'skipped_types'>): AfterPreparing {
  const skipped = (view.skipped_types ?? []).map((entry) => entry.type);
  if (view.status === 'preparing') return { next: 'wait' };
  if (view.status === 'ready') return skipped.length > 0 ? { next: 'show_skipped', skipped } : { next: 'enter' };
  return { next: 'failed', skipped };
}

/**
 * Phase 61 (final review). Reads the session until afterPreparing has an answer. A failed
 * read is read again, as home's poll does: a dropped request is not the session failing.
 * A refusal (4xx) is not, since another read would only repeat it. Null once `alive` says
 * the screen is gone.
 */
export async function pollPrepared(
  read: () => Promise<Pick<SessionView, 'status' | 'skipped_types'>>,
  wait: () => Promise<void>,
  alive: () => boolean,
): Promise<Exclude<AfterPreparing, { next: 'wait' }> | null> {
  while (alive()) {
    try {
      const outcome = afterPreparing(await read());
      if (outcome.next !== 'wait') return alive() ? outcome : null;
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) return { next: 'failed', skipped: [] };
    }
    await wait();
  }
  return null;
}
