import type { VocabularyPage } from '@lang-tutor/core/api';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { expectGeneration } from './support/cards';
import { tapUntil } from './support/interactions';
import { clearGemini, expectGeminiMatching } from './support/mockServer';
import { enrollmentIdOf } from './support/sessions';
import { openApp, signUpLearner } from './support/users';

// Phase 69, phase 74. Words for me, from מילים: the two questions, how many, the choice cards
// with their add or not and its sheets, ✕ to the end, and the session the saves stocked. The
// model's round, each word's lookup and the session's generation are stubbed.
test.setTimeout(180_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

/** The round, in order; the words are in no other spec and not in the seed, so each lookup
 *  reaches MockServer the first time. */
const ROUND: [string, string][] = [
  ['cuscino', 'כרית'],
  ['lampada', 'מנורה'],
  ['ombrello', 'מטרייה'],
  ['forchetta', 'מזלג'],
  ['scarpa', 'נעל'],
  ['zaino', 'תיק גב'],
  ['cassetto', 'מגירה'],
];
// Phase 74 (spec D4). Every word's three wrong meanings: none is a right meaning of the round.
const WRONG = ['אחר', 'שונה', 'רחוק'];

const lookupOf = (lemma: string, translation: string) => ({
  kind: 'word',
  entries: [{ lemma, part_of_speech: 'noun', senses: [{ translation, sense_code: lemma }] }],
});

async function stubRun(request: APIRequestContext) {
  await expectGeminiMatching(
    request,
    'propose new words for a learner',
    { words: ROUND.map(([word, hebrew]) => ({ word, part_of_speech: 'noun', hebrew, alternatives: [], wrong: WRONG })) },
    { once: true, priority: 10 },
  );
  // Each word the learner adds is looked up; its one sense is the round's Hebrew, so no match
  // call is needed.
  for (const [lemma, hebrew] of ROUND) await expectGeminiMatching(request, `"text":"${lemma}"`, lookupOf(lemma, hebrew));
  // The session the run's second saved word stocks.
  await expectGeneration(request);
}

async function savedLemmas(request: APIRequestContext, enrollmentId: string): Promise<string[]> {
  const res = await request.get(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`);
  if (!res.ok()) throw new Error(`GET vocabulary answered ${res.status()}`);
  return ((await res.json()) as VocabularyPage).items.map((word) => word.lemma).sort();
}

/** The card's row whose meaning is `text`, whatever place the shuffle gave it. */
const choice = (page: Page, text: string) => page.locator('[data-testid^="discover-choice-"]').filter({ hasText: new RegExp(`^${text}$`) });

test('a learner picks meanings, adds three words against and with the suggestions, and starts the session they made', async ({ page, request }) => {
  await signUpLearner(page, 'e2e_discover_it', 'it');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubRun(request);

  // מילים, then Words for me: the two questions the first time, then how many.
  await tapUntil(page, 'vocabulary-entry', 'discover-entry');
  await page.getByTestId('discover-entry').click();
  await expect(page.getByTestId('discover-question')).toHaveText('כמה איטלקית אתם כבר יודעים?');
  await page.getByTestId('discover-option-basic').click();
  await expect(page.getByTestId('discover-question')).toHaveText('איפה אתם לומדים איטלקית?');
  await page.getByTestId('discover-option-self').click();
  await expect(page.getByTestId('discover-question')).toHaveText('כמה מילים חדשות?');
  await expect(page.getByTestId('discover-goal-15')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('discover-goal-5').click();
  await page.getByTestId('discover-start').click();

  // A right pick: the suggestion is not to add, and it moves on with no sheet.
  await expect(page.getByTestId('discover-word')).toHaveText('cuscino');
  await expect(page.getByTestId('discover-found')).toHaveText(/נוספו\D*0\D*מתוך\D*5/);
  await expect(page.locator('[data-testid^="discover-choice-"]')).toHaveCount(4);
  await expect(page.getByTestId('discover-add')).toHaveCount(0);
  await choice(page, 'כרית').click();
  await page.getByTestId('discover-skip').click();

  // A wrong pick, then not adding against the suggestion: the sheet explains, and adding stays.
  await expect(page.getByTestId('discover-word')).toHaveText('lampada');
  await choice(page, 'אחר').click();
  await page.getByTestId('discover-skip').click();
  await expect(page.getByText('מומלץ להוסיף מילים שאתם לא מכירים, כדי לתרגל אותן ולזכור אותן.')).toBeVisible();
  await page.getByTestId('discover-sheet-add').click();

  // A right pick added anyway: the sheet asks, and adding is kept.
  await expect(page.getByTestId('discover-word')).toHaveText('ombrello');
  await expect(page.getByTestId('discover-found')).toHaveText(/נוספו\D*1\D*מתוך/);
  await choice(page, 'מטרייה').click();
  await page.getByTestId('discover-add').click();
  await expect(page.getByText('נראה שאתם כבר מכירים את המילה הזאת.')).toBeVisible();
  await page.getByTestId('discover-sheet-add').click();

  // "אין לי מושג", then the suggestion: added at once.
  await expect(page.getByTestId('discover-word')).toHaveText('forchetta');
  await page.getByTestId('discover-dont-know').click();
  await page.getByTestId('discover-add').click();
  await expect(page.getByTestId('discover-word')).toHaveText('scarpa');

  // ✕ with three added ends the run: the end lists them and the session comes ready.
  await page.getByTestId('discover-close').click();
  await expect(page.getByTestId('discover-end-count')).toHaveText('3');
  await expect(page.getByTestId('discover-end-word')).toHaveText(['lampada', 'ombrello', 'forchetta']);
  await expect.poll(() => savedLemmas(page.request, enrollmentId), { timeout: 60_000 }).toEqual(['forchetta', 'lampada', 'ombrello']);
  await expect(page.getByTestId('discover-end-start')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('discover-end-start').click();
  await expect(page.getByTestId('progress-label')).toHaveText(/^\D*1\s*\/\s*\d+/, { timeout: 60_000 });
});
