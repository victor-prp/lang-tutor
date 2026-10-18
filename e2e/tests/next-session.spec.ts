import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK, PROCHITALA } from './support/lexemes';
import { expectGeneration, playOut, readCard, rightOption } from './support/cards';
import { clearGemini } from './support/mockServer';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

// The saved form of each meaning, for reversed, typed and tiles cards (phase 23).
const FORM_OF: Record<string, string> = { קראה: 'прочитала', הקריאה: 'прочитала', בצל: 'лук', קשת: 'лук' };

test('past the seed, a session is built from the saved words', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());

  await withVoices(page, []);
  await signUpLearner(page, 'e2e_next_ru', 'ru');
  await openApp(page);

  // 1. The seed comes first. Enter it, then skip it.
  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();

  // 2. Past the seed with nothing saved: the empty-list state, not a quiz.
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();

  // 3. Save four senses of two words.
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));

  // 4. Home makes the session itself (phase 43, spec D7): no צור שאלות. The
  // generation is stubbed before going back, the job turns the session ready,
  // and home's poll sees it.
  await clearGemini(request);
  await expectGeneration(request);
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('start-button')).toHaveText('לתרגל עכשיו');

  // 5. Every card asks one of the saved words, whichever way round it asks.
  // Phase 39 (spec D5): each word's two senses are a gloss family, and a
  // session asks one gloss of a family, so one word each. Phase 54: both are new
  // words, so each is a ladder (met, then asked three ways); phase 55: built
  // from tiles once met. Ten cards, five of each word.
  await tapUntil(page, 'start-button', 'progress-label');
  const words: string[] = [];
  for (let position = 1; position <= 10; position++) {
    // Whatever type each card is: this test is about the words, not the types.
    const card = await readCard(page, position, 10);
    if (card.kind === 'meet' || card.kind === 'choice' || card.kind === 'meaning') words.push(card.prompt);
    else if (card.kind === 'reverse') words.push(rightOption(card));
    else words.push(FORM_OF[card.prompt]);
    await playOut(page, card);
  }
  expect([...words].sort(), words.join(', ')).toEqual([...Array(5).fill('лук'), ...Array(5).fill('прочитала')]);

  // 6. Results lead home, to the next session: built in stock while this one
  // was played (phase 43, spec D2, D3), so home offers start, not create.
  await expect(page.getByTestId('results-score')).toBeVisible();
  await page.getByTestId('results-next-session').click();
  await expect(page.getByTestId('results-score')).toBeHidden();
  await expect(page.getByTestId('start-button'), `no session in stock\n${report()}`).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('start-button')).toHaveText('לתרגל עכשיו');

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

// Phase 64 (R3): the button says לתרגל עכשיו for a started session too; it resumes it.
test('leaving mid-session offers it again, where it was left', async ({ page, request }) => {
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_resume_ru', 'ru');
  await openApp(page);

  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('option-0').click();
  await page.getByTestId('continue-button').click();
  await expect(page.getByTestId('progress-label')).toHaveText(/2\s*\/\s*10/);
  await page.getByTestId('session-back').click();

  await expect(page.getByTestId('start-button')).toHaveText('לתרגל עכשיו');
  await tapUntil(page, 'start-button', 'progress-label');
  await expect(page.getByTestId('progress-label')).toHaveText(/2\s*\/\s*10/);
});
