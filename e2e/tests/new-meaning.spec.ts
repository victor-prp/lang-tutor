import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, expectGeneration, readCard } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK } from './support/lexemes';
import { knownSeeds, seedMemory } from './support/memory';
import { clearGemini, expectCheck, expectContext } from './support/mockServer';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

const SENTENCE = 'Мой лук и стрелы лежат дома';
const SENTENCE_HEBREW = 'הקשת והחצים שלי נמצאים בבית';
const SENTENCE_WORD = 'лук';
// Phase 62 (spec D2). The line's map, as the context call answers it: Hebrew word by word.
const SENTENCE_WORDS = [
  { hebrew: 'שלי', translation: 'Мой', word: '' },
  { hebrew: 'הקשת', translation: 'лук', word: '' },
  { hebrew: 'והחצים', translation: 'и стрелы', word: '' },
  { hebrew: 'נמצאים', translation: 'лежат', word: '' },
  { hebrew: 'בבית', translation: 'дома', word: '' },
];

// Phase 39 (spec D6). лук has two saved meanings, a family. בצל is known in every skill
// (stability 30, reviewed yesterday), so קשת, never asked, is the family's current gloss and
// is introduced as a new meaning of a word the learner knows.
test('a new meaning of a known word: the card names what is known and shows the new example', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const username = 'e2e_new_meaning_ru';

  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  await openApp(page);

  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();

  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await seedMemory(username, knownSeeds('בצל'));

  await clearGemini(request);
  await expectGeneration(request);
  // The card's key follows its place in the plan, which the spec does not steer: every key answers.
  const keys = Array.from({ length: 10 }, (_, i) => `q${i + 1}`);
  await expectContext(
    request,
    keys.map((key) => ({ key, context: SENTENCE, context_translation: SENTENCE_HEBREW, context_word: SENTENCE_WORD, sentence_words: SENTENCE_WORDS })),
  );
  await expectCheck(request, Object.fromEntries(keys.map((key) => [`${key}c`, { context_meaning: 'קשת' }])));
  // Phase 43 (spec D7). Home makes the session itself, so the memory and the
  // stubs are in place before going back.
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  const total = Number(/\/\s*(\d+)/.exec((await page.getByTestId('progress-label').textContent()) ?? '')?.[1]);
  expect(total, 'the counter shows no total').toBeGreaterThan(0);
  const card = await readCard(page, 1, total, 'new-meaning');

  await expect(page.getByText('פירוש חדש למילה שאתם מכירים')).toBeVisible();
  expect(card.prompt).toBe('лук');
  expect(stripIsolates(await page.getByTestId('known-meanings').textContent())).toBe('כבר למדתם: בצל');
  await expect(page.getByTestId('context-line')).toHaveText(SENTENCE);
  await expect(page.getByTestId('context-line-mark')).toHaveText(SENTENCE_WORD);
  await expect(page.getByTestId('new-meaning-question')).toHaveText('מה עוד המילה אומרת?');
  // The context sentence is drawn once, in the prompt.
  await expect(page.getByTestId('context-line')).toHaveCount(1);
  expect(card.options).toContain('קשת');
  expect(card.options).not.toContain('בצל');

  // Phase 62 (spec D3, D5, D7). The line is an example, tapped word by word for its
  // Hebrew; the word itself is the question and is never tapped. Once answered, every
  // word shows its Hebrew, and the whole sentence's.
  await expect(page.getByTestId('context-label')).toHaveText('משפט לדוגמה:');
  await expect(page.getByText('הקישו על מילה כדי לראות אותה בעברית')).toBeVisible();
  await expect(page.getByTestId('context-line-word-0-text')).toHaveCount(0);
  await page.getByTestId('context-line-word-0').click();
  await expect(page.getByTestId('context-line-word-0-text')).toHaveText('שלי');
  await expect(page.getByTestId('context-line-mark-text')).toHaveCount(0);
  const sent = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/next-step'));
  await answerChoice(page, card, true);
  expect((await sent).postDataJSON()).toMatchObject({ tapped: [0] });
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('context-line-word-2-text')).toHaveText('והחצים');
  await expect(page.getByTestId('context-line-mark-text')).toHaveText('הקשת');
  await expect(page.getByTestId('context-translation')).toContainText('המשפט בעברית:');
  await expect(page.getByTestId('context-translation')).toContainText(SENTENCE_HEBREW);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
