import { expect, test, type Page } from '@playwright/test';

import { clearGemini, expectGemini } from './support/mockServer';
import { createLearner, logIn } from './support/users';

test.setTimeout(120_000);

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

async function startSession(page: Page) {
  await expect(async () => {
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('progress-label')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function openTranslate(page: Page) {
  await expect(async () => {
    await page.getByTestId('translate-entry').click();
    await expect(page.getByTestId('translate-input')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('a Russian learner gets a Russian session', async ({ page, request }) => {
  await createLearner(request, 'e2e_ru_session', 'ru');
  await logIn(page, 'e2e_ru_session');

  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: רוסית');
  await startSession(page);
  await expect(page.getByTestId('question-prompt')).toHaveText(CYRILLIC);
});

test('a Russian lookup opens ru → he, is served from the seed, and flips to he → ru', async ({
  page,
  request,
}) => {
  // Only the flipped lookup reaches the model: окно is seeded.
  await expectGemini(request, {
    kind: 'word',
    entries: [
      {
        lemma: 'חלון',
        part_of_speech: 'noun',
        senses: [
          {
            translation: 'окно',
            example: { source: 'פתחתי את החלון.', target: 'Я открыл окно.' },
            sense_code: 'window_opening',
          },
        ],
      },
    ],
  });
  await createLearner(request, 'e2e_ru_lookup', 'ru');
  await logIn(page, 'e2e_ru_lookup');
  await openTranslate(page);

  await expect(page.getByTestId('translate-direction')).toHaveText('מרוסית לעברית');
  await page.getByTestId('translate-input').fill('окно');
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-sense').first()).toBeVisible();

  await page.getByTestId('translate-flip').click();
  await expect(page.getByTestId('translate-direction')).toHaveText('מעברית לרוסית');
  await expect(page.getByTestId('translate-input')).not.toHaveValue('окно');
  await expect(page.getByText('окно', { exact: true })).toBeVisible();
});

test('Hebrew typed under ru → he offers a one-tap flip', async ({ page, request }) => {
  await expectGemini(request, {
    kind: 'word',
    entries: [
      {
        lemma: 'שלום',
        part_of_speech: 'interjection',
        senses: [
          {
            translation: 'привет',
            example: { source: 'שלום, מה נשמע?', target: 'Привет, как дела?' },
            sense_code: 'greeting',
          },
        ],
      },
    ],
  });
  await createLearner(request, 'e2e_ru_wrong_way', 'ru');
  await logIn(page, 'e2e_ru_wrong_way');
  await openTranslate(page);

  await page.getByTestId('translate-input').fill('שלום');
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-flip-retry')).toBeVisible();

  await page.getByTestId('translate-flip-retry').click();
  await expect(page.getByTestId('translate-direction')).toHaveText('מעברית לרוסית');
  await expect(page.getByText('привет', { exact: true })).toBeVisible();
});

test('a learner adds English, switches both ways, and the choice survives signing in again', async ({
  page,
  request,
}) => {
  await createLearner(request, 'e2e_switcher', 'ru');
  await logIn(page, 'e2e_switcher');

  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-add').click();
  await page.getByTestId('enroll-en').click();
  await page.getByTestId('enroll-submit').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: אנגלית');

  await startSession(page);
  await expect(page.getByTestId('question-prompt')).toHaveText(LATIN);
  await page.getByTestId('session-back').click();

  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-option-ru').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: רוסית');
  await startSession(page);
  await expect(page.getByTestId('question-prompt')).toHaveText(CYRILLIC);
  await page.getByTestId('session-back').click();

  await openTranslate(page);
  await expect(page.getByTestId('translate-direction')).toHaveText('מרוסית לעברית');
  await page.getByTestId('translate-back').click();

  // Every adding of a language is remembered; the last switch was to Russian.
  await page.getByTestId('profile-button').click();
  await page.getByTestId('switch-user-button').click();
  await logIn(page, 'e2e_switcher');
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: רוסית');
});
