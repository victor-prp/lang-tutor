import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK, PROCHITALA } from './support/lexemes';
import { answerChoice, answerTyped, expectGeneration, readCard, retypeWrong } from './support/cards';
import { knownSeeds, seedMemory, type MemorySeed } from './support/memory';
import { clearGemini } from './support/mockServer';
import { continueMeet } from './support/sessions';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

const DIMENSIONS = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];

/**
 * Phase 39 (spec D2, D3, D6). בצל is known in every skill, so קשת, never asked,
 * is лук's current meaning and comes as a new meaning; of прочитала's two new
 * meanings one is asked and the other waits. So two cards, a new meaning of лук
 * and a choice of meanings for прочитала. בצל's levels put лук's badge, the
 * mean of its ten levels with ties up, just under נחשפה: 3, 2, 2, 1, 1 beside
 * קשת's five 1s is 14/10 = 1.4. One right answer lifts קשת's recognition to 2
 * (phase 23, spec D6), and лук to 15/10 = 1.5: נחשפה.
 */
const BATZAL_LEVELS: Record<MemorySeed['dimension'], number> = {
  written_receptive: 3,
  written_productive: 2,
  spelling: 2,
  spoken_receptive: 1,
  spoken_productive: 1,
};
const MEMORY: MemorySeed[] = knownSeeds('בצל').map((seed) => ({ ...seed, level: BATZAL_LEVELS[seed.dimension] }));

test('a session moves the words it practised up the ladder, and the list filters by level', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());

  await withVoices(page, []);
  await signUpLearner(page, 'e2e_progress_ru', 'ru');
  await openApp(page);

  // 1. Past the seed, with four saved senses of two words.
  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await seedMemory('e2e_progress_ru', MEMORY);

  // 2. A list session: лук answered right, прочитала wrong. Phase 54: прочитала
  // is a new word, so it is a ladder, met first and then asked three ways; phase
  // 55: built from tiles right after it is met. лук is one card, so six in all.
  // Where each falls is the plan's (spec D5), so each card is answered by its
  // kind. Home makes the session on the way back (phase 43, spec D7), so the
  // memory and the generation are in place before.
  await clearGemini(request);
  await expectGeneration(request);
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');
  const kinds: string[] = [];
  for (let position = 1; position <= 6; position++) {
    const card = await readCard(page, position, 6);
    kinds.push(card.kind);
    if (card.kind === 'meet') {
      expect(card.prompt).toBe('прочитала');
      await continueMeet(page);
      continue;
    }
    if (card.kind === 'new-meaning') {
      expect(card.prompt).toBe('лук');
      await answerChoice(page, card, true);
    } else if (card.kind === 'tiles') {
      await page.getByTestId('tiles-show-answer').click();
      await expect(page.getByTestId('feedback-wrong')).toBeVisible();
    } else if (card.kind === 'typed') {
      // Phase 55 (spec D7): a wrong word is typed again, wrong twice more here, before its banner.
      await answerTyped(page, 'неверно');
      await retypeWrong(page, 'неверно');
    } else {
      expect(['choice', 'reverse'], `position ${position}`).toContain(card.kind);
      await answerChoice(page, card, false);
    }
    await page.getByTestId('continue-button').click();
  }
  // The ladder's cards, in order, and the new meaning once.
  expect(kinds.filter((kind) => kind !== 'new-meaning'), kinds.join(', ')).toEqual(['meet', 'tiles', 'choice', 'reverse', 'typed']);
  expect(kinds.filter((kind) => kind === 'new-meaning')).toHaveLength(1);

  // 3. Results: two practised words. The new meaning moved קשת's recognition
  // and not its badge (2,1,1,1,1 is 1.2), and says so; прочитала's ladder,
  // answered wrong throughout, moves nothing, the meet card is no miss, and the
  // missed list names the word once, not once per wrong card.
  await expect(page.getByTestId('practised-row')).toHaveCount(2);
  await expect(page.getByTestId('missed-row')).toHaveCount(1);
  await expect(page.getByTestId('missed-row')).toContainText('прочитала');
  await expect(page.getByTestId('practised-raised')).toHaveCount(0);
  await expect(page.getByTestId('practised-progressed')).toHaveCount(1);
  await expect(page.getByTestId('practised-row').filter({ hasText: 'קשת' }).getByTestId('practised-progressed')).toHaveText(
    'התקדמות: זיהוי בכתב',
  );

  // 4. The list: лук at the mean of its two senses' levels, which the session
  // lifted to נחשפה; прочитать at חדשה.
  await page.getByTestId('results-done').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(2);
  await expect(words.filter({ hasText: 'лук' }).getByTestId('vocabulary-word-level-name')).toHaveText('נחשפה');
  await expect(words.filter({ hasText: 'прочитать' }).getByTestId('vocabulary-word-level-name')).toHaveText('חדשה');

  // 5. No sorts any more, and the filter opens on "all".
  await expect(page.locator('[data-testid^="vocabulary-sort-"]')).toHaveCount(0);
  const levelAll = page.getByTestId('vocabulary-level-all');
  const level2 = page.getByTestId('vocabulary-level-2');
  await expect(levelAll).toHaveText('הכל');
  await expect(levelAll).toHaveAttribute('aria-selected', 'true');

  // 6. Filter to a level, an empty level, and "all" to clear it. Level 2
  // holds лук alone.
  await level2.click();
  await expect(words).toHaveCount(1);
  await expect(words.first()).toContainText('лук');
  await expect(levelAll).toHaveAttribute('aria-selected', 'false');
  await expect(level2).toHaveAttribute('aria-selected', 'true');
  await levelAll.click();
  await expect(words).toHaveCount(2);
  await expect(levelAll).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('vocabulary-level-4').click();
  await expect(page.getByTestId('vocabulary-empty-level')).toBeVisible();
  await levelAll.click();
  await expect(words).toHaveCount(2);

  // 7. A word's detail: five dimensions, all live since phase 25.
  await words.filter({ hasText: 'лук' }).click();
  await expect(page.getByTestId('vocabulary-sense-level')).toHaveCount(2);
  // Each of the two saved senses shows all five dimensions; spoken_receptive is
  // live since phase 24 (listening cards) and spoken_productive since phase 25
  // (speaking cards), so both read חדשה and nothing reads "not practised yet".
  // The right answer raised קשת's recognition; בצל's reads as seeded.
  for (const dimension of DIMENSIONS) {
    await expect(page.getByTestId(`vocabulary-dimension-${dimension}`)).toHaveCount(2);
  }
  const dimensionRows = page.locator('[data-testid^="vocabulary-dimension-"]');
  await expect(dimensionRows).toHaveCount(10);
  const sense = (meaning: string) => page.getByTestId('vocabulary-sense').filter({ hasText: meaning });
  await expect(sense('קשת').getByTestId('vocabulary-dimension-written_receptive')).toContainText('נחשפה');
  await expect(sense('בצל').getByTestId('vocabulary-dimension-written_receptive')).toContainText('מוכרת');
  await expect(page.getByTestId('vocabulary-dimension-spoken_receptive')).toHaveText([/חדשה/, /חדשה/]);
  await expect(page.getByTestId('vocabulary-dimension-spoken_productive')).toHaveText([/חדשה/, /חדשה/]);
  await expect(dimensionRows.filter({ hasText: 'טרם תורגל' })).toHaveCount(0);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
