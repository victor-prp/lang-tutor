import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { clearGemini, expectGemini, expectGeminiFailure } from './support/mockServer';
import { createLearner, logIn } from './support/users';

// Three page loads and a handful of round trips — well inside this, and well
// above Playwright's 30s default.
test.setTimeout(120_000);

const BOOK_SENSES = [
  {
    translation: 'ספר',
    part_of_speech: 'noun',
    example: { source: 'I read a book about space.', target: 'קראתי ספר על החלל.' },
  },
  {
    translation: 'להזמין',
    part_of_speech: 'verb',
    example: { source: "I'd like to book a table.", target: 'אני רוצה להזמין שולחן.' },
  },
  {
    translation: 'לרשום',
    part_of_speech: 'verb',
    example: { source: 'The referee booked him.', target: 'השופט רשם לו כרטיס.' },
  },
];

// `exact: true` throughout. The top card's example target is
// "קראתי ספר על החלל.", which *contains* "ספר" — a substring match would find
// two elements and fail Playwright's strict mode rather than the assertion.
const sense = (page: Page, text: string) => page.getByText(text, { exact: true });

// Registers expectations through Playwright's `request` fixture, the pattern
// phase 8 established for creating a learner via POST /api/users.
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

async function openTranslate(page: Page, request: APIRequestContext, username: string) {
  await createLearner(request, username);
  await logIn(page, username);
  // Retried for the same reason session.spec.ts retries its start click: a
  // static export serves markup before React hydrates, so an early click is a
  // silent no-op.
  await expect(async () => {
    await page.getByTestId('translate-entry').click();
    await expect(page.getByTestId('translate-input')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('a word shows its most common meaning, reveals the rest, and confirms a choice', async ({
  page,
  request,
}) => {
  await expectGemini(request, { kind: 'word', senses: BOOK_SENSES });
  await openTranslate(page, request, 'e2e_translate_word');

  await page.getByTestId('translate-input').fill('book');
  await page.getByTestId('translate-submit').click();

  // The top sense only, with the other two behind `more`.
  await expect(sense(page, 'ספר')).toBeVisible();
  await expect(sense(page, 'להזמין')).toBeHidden();
  await expect(page.getByTestId('translate-more')).toContainText('2');

  await page.getByTestId('translate-more').click();
  await expect(sense(page, 'להזמין')).toBeVisible();
  await expect(sense(page, 'לרשום')).toBeVisible();

  await page.getByTestId('translate-choose').nth(1).click();
  await expect(page.getByTestId('translate-chosen')).toHaveText('התרגום נשמר לאוצר המילים שלך');
  await expect(page.getByTestId('translate-new-word')).toBeVisible();
});

test('a sentence gets one translation, with neither more nor a save button', async ({
  page,
  request,
}) => {
  await expectGemini(request, {
    kind: 'sentence',
    senses: [{ translation: 'אני מצפה לראות אותך.' }],
  });
  await openTranslate(page, request, 'e2e_translate_sentence');

  await page.getByTestId('translate-input').fill("I'm looking forward to seeing you");
  await page.getByTestId('translate-submit').click();

  await expect(sense(page, 'אני מצפה לראות אותך.')).toBeVisible();
  await expect(page.getByTestId('translate-more')).toHaveCount(0);
  await expect(page.getByTestId('translate-choose')).toHaveCount(0);
});

test('gibberish says so instead of inventing a translation', async ({ page, request }) => {
  await expectGemini(request, { kind: 'word', senses: [] });
  await openTranslate(page, request, 'e2e_translate_empty');

  await page.getByTestId('translate-input').fill('asdkjhasd');
  await page.getByTestId('translate-submit').click();

  await expect(page.getByTestId('translate-empty')).toHaveText('לא מצאנו תרגום');
});

test('a failing provider shows the error, and retry works once it recovers', async ({
  page,
  request,
}) => {
  await expectGeminiFailure(request, 500);
  await openTranslate(page, request, 'e2e_translate_retry');

  await page.getByTestId('translate-input').fill('book');
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-error')).toBeVisible();

  // Replacing the expectation is what makes this a test of retry *working*
  // rather than of the error state rendering.
  await clearGemini(request);
  await expectGemini(request, { kind: 'word', senses: BOOK_SENSES });

  await page.getByTestId('translate-retry').click();
  await expect(sense(page, 'ספר')).toBeVisible();
});
