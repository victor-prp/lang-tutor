import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK, PROCHITALA } from './support/lexemes';
import { expectGeneration, playOut, readCard, rightOption } from './support/cards';
import { clearGemini } from './support/mockServer';
import { enrollmentIdOf, makeSeed } from './support/sessions';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

// The saved form of each meaning, for reversed, typed and tiles cards (phase 23).
const FORM_OF: Record<string, string> = { קראה: 'прочитала', הקריאה: 'прочитала', בצל: 'лук', קשת: 'лук' };

test('with nothing saved the card offers Words for me, and a session is built from the saved words', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);

  await withVoices(page, []);
  await signUpLearner(page, 'e2e_next_ru', 'ru');
  await openApp(page);

  // 1–2. Nothing saved: the card never starts the seed (phase 73, spec D6). Its button opens Words
  // for me, not a quiz, and closing it is home again.
  await tapUntil(page, 'start-button', 'discover-close');
  await expect(page.getByTestId('progress-label'), report()).toHaveCount(0);
  await page.getByTestId('discover-close').click();
  await expect(page.getByTestId('home-my-words'), report()).toBeVisible();

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

  // 6. The next session was built in stock while this one was played (phase 43, spec D2, D3). A
  // My words session's results continue into it (phase 73, spec D7); סיום leads home, which offers
  // it: start, not create.
  await expect(page.getByTestId('results-score')).toBeVisible();
  await expect(page.getByTestId('results-my-words')).toBeVisible();
  await expect(page.getByTestId('results-continue')).toBeVisible();
  await expect(page.getByTestId('results-next-session')).toHaveCount(0);
  await page.getByTestId('results-done').click();
  await expect(page.getByTestId('results-score')).toBeHidden();
  await expect(page.getByTestId('start-button'), `no session in stock\n${report()}`).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('start-button')).toHaveText('לתרגל עכשיו');

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

// Phase 64 (R3): the button says לתרגל עכשיו for a started session too; it resumes it.
test('leaving mid-session offers it again, where it was left', async ({ page, request }) => {
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_resume_ru', 'ru');
  // The seed's ten fixed choices, made over the API: the card never starts it (phase 73, spec D6),
  // and home offers it as any ready session.
  await makeSeed(page.request, await enrollmentIdOf(page.request));
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
