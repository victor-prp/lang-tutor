import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerTyped, expectGeneration, readCard } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { SINGLE_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { makeTester } from './support/tester';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

// Phase 61 (spec D1–D6). A tester opens a saved word's question types from its page,
// keeps two, and answers the session they make.
const WORD = SINGLE_WORDS.jug;
const KEEP = new Set(['multiple_choice', 'typed_translation']);

test('a tester starts a session of the question types they chose for one word', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const username = 'e2e_word_types';
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  await openApp(page);

  // One word saved before any session: the main path's first is the list's, never the seed (phase
  // 73, spec D6).
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, WORD.form, WORD.payload);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save'));
  await page.getByTestId('translate-back').click();

  // Not a tester: the word's page offers nothing.
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  await page.getByTestId('vocabulary-word').first().click();
  await expect(page.getByTestId('vocabulary-sense')).toHaveCount(1);
  await expect(page.getByTestId('question-types-link')).toHaveCount(0);

  // A tester, once the app reads the profile again.
  await makeTester(username);
  // Home has no start button now: the stock the save asked for found no model stub.
  await openApp(page, 'vocabulary-entry');
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  await page.getByTestId('vocabulary-word').first().click();
  await page.getByTestId('question-types-link').click();

  // Every type, matching greyed with why; with no voice, no listening card either.
  const matching = page.getByTestId('question-type-matching');
  await expect(matching, report()).toBeVisible();
  await expect(matching).toBeDisabled();
  await expect(matching).toContainText('צריך לפחות 7 מילים');
  await expect(page.getByTestId('question-type-dictation')).toContainText('אין במכשיר קול לשפה');

  // Keep two: untick every other ticked type.
  const rows = page.locator('[data-testid^="question-type-"]');
  for (let index = 0; index < (await rows.count()); index++) {
    const row = rows.nth(index);
    const type = (await row.getAttribute('data-testid'))!.replace('question-type-', '');
    if ((await row.getAttribute('aria-checked')) === 'true' && !KEEP.has(type)) await row.click();
  }
  for (const type of KEEP) await expect(page.getByTestId(`question-type-${type}`)).toHaveAttribute('aria-checked', 'true');

  await clearGemini(request);
  await expectGeneration(request);
  // Final review (minor 7): a double tap makes one session, not two.
  let creates = 0;
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url().includes('/question-type-sessions')) creates += 1;
  });
  await page.getByTestId('question-types-start').dblclick();

  // The two cards, in the read's order, then the results.
  const choice = await readCard(page, 1, 2, 'choice');
  expect(creates).toBe(1);
  await answerChoice(page, choice, true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();
  await readCard(page, 2, 2, 'typed');

  // Final review (important 2): backing out of the session, the screen offers it again.
  await page.getByTestId('session-back').click();
  await page.getByTestId('question-types-resume').click();
  await readCard(page, 2, 2, 'typed');
  await answerTyped(page, WORD.form);
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון!');
  await page.getByTestId('continue-button').click();
  await expect(page.getByTestId('results-score'), report()).toBeVisible();
});
