import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK, PROCHITALA } from './support/lexemes';
import { answerChoice, answerTyped, generationStub, readCard, rightOption, type CardKind } from './support/cards';
import { clearGemini, expectGeminiPayload } from './support/mockServer';
import { createLearner, logIn } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

const DIMENSIONS = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];
// The saved form of each meaning, for reversed and typed cards (phase 23).
const FORM_OF: Record<string, string> = { קראה: 'прочитала', הקריאה: 'прочитала', בצל: 'лук', קשת: 'лук' };

// Phase 23. What one right answer does to a new sense's three written levels
// (spec D6), then the two spoken ones, which stay at 1 (phases 24, 25 made them
// live), and the badge over all five: the mean, ties up.
const LEVELS_AFTER_RIGHT: Record<string, number[]> = {
  choice: [2, 1, 1, 1, 1],
  reverse: [2, 2, 1, 1, 1],
  typed: [2, 2, 2, 1, 1],
};
const badgeOf = (levels: number[]) => Math.floor(levels.reduce((a, b) => a + b, 0) / levels.length + 0.5);

test('a session moves the words it practised up the ladder, and the list filters by level', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());

  await withVoices(page, []);
  await createLearner(request, 'e2e_progress_ru', 'ru');
  await logIn(page, 'e2e_progress_ru');

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
  await page.getByTestId('translate-back').click();

  // 2. A list session: лук answered right, прочитала wrong, whatever each card's
  // type. Which word lands on which position is random, so the test records
  // the type each лук card had and works out the levels from it.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStub());
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');
  const lukKinds: CardKind[] = [];
  for (let position = 1; position <= 4; position++) {
    const card = await readCard(page, position, 4);
    const word = card.kind === 'choice' ? card.prompt : card.kind === 'reverse' ? rightOption(card) : FORM_OF[card.prompt];
    const right = word === 'лук';
    if (right) lukKinds.push(card.kind);
    if (card.kind === 'typed') {
      if (right) await answerTyped(page, 'лук');
      else await page.getByTestId('typed-show-answer').click();
    } else {
      await answerChoice(page, card, right);
    }
    await page.getByTestId('continue-button').click();
  }
  expect(lukKinds).toHaveLength(2);

  // 3. Results: four practised words. A лук card that was typed
  // raises its badge to נחשפה (the mean of 2,2,2,1,1 is 1.6); one that was today's card moves recognition
  // only, and says so. прочитала moves nothing.
  const lukBadges = lukKinds.map((kind) => badgeOf(LEVELS_AFTER_RIGHT[kind]));
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  await expect(page.getByTestId('practised-raised')).toHaveCount(lukBadges.filter((level) => level === 2).length);
  await expect(page.getByTestId('practised-progressed')).toHaveCount(lukBadges.filter((level) => level === 1).length);
  const raised = page.getByTestId('practised-row').filter({ has: page.getByTestId('practised-raised') });
  for (const row of await raised.all()) {
    await expect(row).toContainText('лук');
    await expect(row.getByTestId('practised-level-name')).toHaveText('נחשפה');
  }

  // 4. The list: лук at the mean of its two senses' levels, прочитать at חדשה.
  const lukLevel = badgeOf(lukKinds.flatMap((kind) => LEVELS_AFTER_RIGHT[kind]));
  await page.getByTestId('results-done').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(2);
  await expect(words.filter({ hasText: 'лук' }).getByTestId('vocabulary-word-level-name')).toHaveText(
    lukLevel === 2 ? 'נחשפה' : 'חדשה',
  );
  await expect(words.filter({ hasText: 'прочитать' }).getByTestId('vocabulary-word-level-name')).toHaveText('חדשה');

  // 5. No sorts any more, and the filter opens on "all".
  await expect(page.locator('[data-testid^="vocabulary-sort-"]')).toHaveCount(0);
  const levelAll = page.getByTestId('vocabulary-level-all');
  const level2 = page.getByTestId('vocabulary-level-2');
  await expect(levelAll).toHaveText('הכל');
  await expect(levelAll).toHaveAttribute('aria-selected', 'true');

  // 6. Filter to a level, an empty level, and "all" to clear it. лук reads
  // חדשה only when both its cards were today's card, beside прочитать.
  await level2.click();
  await expect(words).toHaveCount(lukLevel === 2 ? 1 : 0);
  if (lukLevel === 2) await expect(words.first()).toContainText('лук');
  await expect(levelAll).toHaveAttribute('aria-selected', 'false');
  await expect(level2).toHaveAttribute('aria-selected', 'true');
  await levelAll.click();
  await expect(words).toHaveCount(2);
  await expect(levelAll).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('vocabulary-level-4').click();
  await expect(page.getByTestId('vocabulary-empty-level')).toBeVisible();
  await levelAll.click();
  await expect(words).toHaveCount(2);

  // 7. A word's detail: five dimensions, three live since phase 23.
  await words.filter({ hasText: 'лук' }).click();
  await expect(page.getByTestId('vocabulary-sense-level')).toHaveCount(2);
  // Each of the two saved senses shows all five dimensions; spoken_receptive is
  // live since phase 24 (listening cards) and spoken_productive since phase 25
  // (speaking cards), so both read חדשה and nothing reads "not practised yet".
  // Every right answer, of any type, raised recognition.
  for (const dimension of DIMENSIONS) {
    await expect(page.getByTestId(`vocabulary-dimension-${dimension}`)).toHaveCount(2);
  }
  const dimensionRows = page.locator('[data-testid^="vocabulary-dimension-"]');
  await expect(dimensionRows).toHaveCount(10);
  await expect(page.getByTestId('vocabulary-dimension-written_receptive')).toHaveText([/נחשפה/, /נחשפה/]);
  await expect(page.getByTestId('vocabulary-dimension-spoken_receptive')).toHaveText([/חדשה/, /חדשה/]);
  await expect(page.getByTestId('vocabulary-dimension-spoken_productive')).toHaveText([/חדשה/, /חדשה/]);
  await expect(dimensionRows.filter({ hasText: 'טרם תורגל' })).toHaveCount(0);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
