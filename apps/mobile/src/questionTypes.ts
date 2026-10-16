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
