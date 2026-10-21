import type { VocabularyPage } from '@lang-tutor/core/api';
import { expect, test, type APIRequestContext } from '@playwright/test';

import { API_URL } from '../urls';
import { tapUntil } from './support/interactions';
import { clearGemini, expectGeminiMatching } from './support/mockServer';
import { enrollmentIdOf } from './support/sessions';
import { openApp, signUpLearner } from './support/users';

// Phase 69. Words for me, from מילים: the two questions, how many, the cards, the list and
// My words. The model's round, the judge and each word's lookup are stubbed.
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

const lookupOf = (lemma: string, translation: string) => ({
  kind: 'word',
  entries: [{ lemma, part_of_speech: 'noun', senses: [{ translation, sense_code: lemma }] }],
});

async function stubRun(request: APIRequestContext) {
  await expectGeminiMatching(
    request,
    'propose new words for a learner',
    { words: ROUND.map(([word, hebrew]) => ({ word, part_of_speech: 'noun', hebrew, alternatives: [] })) },
    { once: true, priority: 10 },
  );
  // Only lampada's answer reaches the judge: cuscino's matches its meaning by rule.
  await expectGeminiMatching(request, "judge the learner's answer", { verdict: 'wrong' }, { once: true, priority: 10 });
  // Each word the learner did not know is looked up; its one sense is the round's Hebrew,
  // so no match call is needed.
  for (const [lemma, hebrew] of ROUND) await expectGeminiMatching(request, `"text":"${lemma}"`, lookupOf(lemma, hebrew));
}

async function savedLemmas(request: APIRequestContext, enrollmentId: string): Promise<string[]> {
  const res = await request.get(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`);
  if (!res.ok()) throw new Error(`GET vocabulary answered ${res.status()}`);
  return ((await res.json()) as VocabularyPage).items.map((word) => word.lemma).sort();
}

test('a learner finds five new words and keeps four', async ({ page, request }) => {
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

  // A right meaning, by rule.
  await expect(page.getByTestId('discover-word')).toHaveText('cuscino');
  await expect(page.getByTestId('discover-to-list')).toHaveCount(0);
  await page.getByTestId('discover-input').fill('כרית');
  await page.getByTestId('discover-check').click();
  await expect(page.getByTestId('discover-verdict')).toHaveText('✓ נכון');
  await page.getByTestId('discover-next').click();

  // A wrong one, judged: it counts as not known, and its meaning shows.
  await expect(page.getByTestId('discover-word')).toHaveText('lampada');
  await page.getByTestId('discover-input').fill('שולחן');
  await page.getByTestId('discover-check').click();
  await expect(page.getByTestId('discover-verdict')).toHaveText('לא בדיוק — מנורה');
  await page.getByTestId('discover-next').click();

  // "Don't know" until five are not known: the fifth opens the list, so cassetto never shows.
  for (const word of ['ombrello', 'forchetta', 'scarpa', 'zaino']) {
    await expect(page.getByTestId('discover-word')).toHaveText(word);
    await expect(page.getByTestId('discover-to-list')).toBeVisible();
    await page.getByTestId('discover-dont-know').click();
  }

  const rows = page.getByTestId('photo-import-row');
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId('discover-looking-up')).toHaveCount(0, { timeout: 60_000 });
  await expect(rows.filter({ hasText: 'lampada' }).getByTestId('photo-import-meaning')).toContainText('מנורה');
  const zaino = rows.filter({ hasText: 'zaino' }).getByTestId('photo-import-tick');
  await zaino.click();
  await expect(zaino).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('discover-save')).toContainText('הוספת');

  // Nothing joins the list before Continue.
  expect(await savedLemmas(page.request, enrollmentId)).toEqual([]);
  await page.getByTestId('discover-save').click();
  await expect(page.getByTestId('home-photo-saved')).toContainText('נשמרו');
  expect(await savedLemmas(page.request, enrollmentId)).toEqual(['forchetta', 'lampada', 'ombrello', 'scarpa']);
});
