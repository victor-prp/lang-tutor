import type { ExplainResponse, Question, SentenceMistake } from '@lang-tutor/core/api';
import { normaliseTyped } from '@lang-tutor/core/domain';

import type { CardAnswer } from '@/feedback';
import { strings } from '@/strings';

/**
 * Phase 66 (spec D3). The הסבר button on a sentence translation card: which
 * answer it explains, and what a tap shows. The explanation grades nothing.
 */

/** The text the button explains: a translation card's typed final answer, not
 *  empty and not the reference as typed. Null: no button. */
export function explainText(question: Question, answer: CardAnswer | null): string | null {
  if (question.type !== 'sentence_translation' || answer === null || !('text' in answer)) return null;
  const typed = normaliseTyped(answer.text);
  return typed === '' || typed === normaliseTyped(question.sentence) ? null : answer.text;
}

/** Where the explain request is: asked as soon as the button shows. */
export type ExplainLoad = { status: 'loading' } | { status: 'ready'; explanation: ExplainResponse } | { status: 'failed' };

export type ExplainPanel = { kind: 'line'; text: string } | { kind: 'mistakes'; corrected: string; mistakes: SentenceMistake[] };

export function explainPanel(load: ExplainLoad): ExplainPanel {
  switch (load.status) {
    case 'loading':
      return { kind: 'line', text: strings.explainLoading };
    case 'failed':
      return { kind: 'line', text: strings.explainFailed };
    case 'ready':
      return load.explanation.mistakes.length === 0
        ? { kind: 'line', text: strings.explainNone }
        : { kind: 'mistakes', corrected: load.explanation.corrected, mistakes: load.explanation.mistakes };
  }
}
