import type { LlmCheck } from '@lang-tutor/core/api';

import { meaningFits, readCheck, translationUses, wordsFit, wrongOnly } from '../../src/domain/check';
import type { CheckCase } from './cases';

/**
 * Phase 34 (spec D5). How a checker case is scored, apart from run.ts so a
 * check can be shown to fire on a hand-made answer without a call (run.ts runs
 * the whole eval when it is imported), as contextChecks.ts does for the context call.
 */
export type Check = { name: string; ok: boolean; detail?: string };

/** The answer reads as the server reads it: every option answered, in number. */
export function checkTier1(kase: CheckCase, answer: LlmCheck): Check[] {
  const reading = readCheck([kase.item], answer);
  return [{ name: 'the answer reads', ok: reading.ok, detail: reading.ok ? undefined : reading.reason }];
}

/** The answer means what a careful reader means, by the server's own rules. */
export function checkTier2(kase: CheckCase, answer: LlmCheck): Check[] {
  const reading = readCheck([kase.item], answer);
  if (!reading.ok) return [];
  const finding = reading.byKey.get(kase.item.key)!;
  const { item } = kase;
  switch (finding.task) {
    case 'choice':
    case 'gap': {
      const options = 'options' in item ? item.options : [];
      const left = wrongOnly(options, finding.alsoRight);
      return Object.entries(kase.alsoRight ?? {}).map(([option, right]): Check => ({
        name: `${option} ${finding.task === 'gap' ? (right ? 'fits' : 'does not fit') : right ? 'is also right' : 'is wrong'}`,
        ok: left.includes(option) !== right,
        detail: `called right: ${options.filter((text) => !left.includes(text)).join(', ') || '(none)'}`,
      }));
    }
    case 'meaning': {
      const checks: Check[] = [
        {
          name: kase.keep ? `read as ${kase.glossMeanings!.join('/')}, so kept` : `not read as ${kase.glossMeanings!.join('/')}, so dropped`,
          ok: meaningFits(finding.meaning, kase.glossMeanings ?? []) === kase.keep,
          detail: finding.meaning || '(none)',
        },
      ];
      if (kase.notMeanings) {
        checks.push({ name: `not read as ${kase.notMeanings.join('/')}`, ok: !meaningFits(finding.meaning, kase.notMeanings), detail: finding.meaning || '(none)' });
      }
      return checks;
    }
    case 'words':
      return [
        {
          name: kase.keep ? `a word the card for ${kase.card!.answer} accepts, so kept` : `no word the card for ${kase.card!.answer} accepts, so dropped`,
          ok: wordsFit(finding.words, kase.card!) === kase.keep,
          detail: finding.words.join(', ') || '(none)',
        },
      ];
    case 'translate':
      return [
        {
          name: kase.keep ? `uses ${kase.practised!.join('/')}, so kept` : `uses no ${kase.practised!.join('/')}, so degraded`,
          ok: translationUses(finding.translation, kase.practised ?? []) === kase.keep,
          detail: finding.translation || '(none)',
        },
      ];
  }
}

export function checkWritten(kase: CheckCase, answer: LlmCheck): string[] {
  const got = answer.items.find((item) => item.key === kase.item.key);
  return [
    `options=${JSON.stringify(got?.options ?? got?.gap_fits ?? null)} meaning=${got?.context_meaning ?? ''} words=${(got?.context_words ?? []).join(', ')} translation=${got?.natural_translation ?? ''}`,
  ];
}
