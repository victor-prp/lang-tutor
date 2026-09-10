import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { clearGemini, expectGemini, expectGeminiFailure } from './support/mockServer';
import { createLearner, logIn } from './support/users';

// Three page loads and a handful of round trips — well inside this, and well
// above Playwright's 30s default.
test.setTimeout(120_000);

// Every spec here that expects a provider call uses a string the seed does not
// contain. As of phase 10 a seeded string answers from Postgres and never
// reaches MockServer — which is the whole point, and would otherwise turn the
// 502 and timeout tests into silent 200s.

const LADDER_ENTRIES = [
  {
    lemma: 'ladder',
    senses: [
      {
        translation: 'סולם',
        part_of_speech: 'noun',
        example: { source: 'She climbed the ladder.', target: 'היא טיפסה על הסולם.' },
        sense_code: 'climbing_frame',
      },
      {
        translation: 'דירוג',
        part_of_speech: 'noun',
        example: { source: 'He moved up the corporate ladder.', target: 'הוא עלה בסולם הדרגות.' },
        sense_code: 'ranking',
      },
      {
        translation: 'להוביל',
        part_of_speech: 'verb',
        example: { source: 'The path ladders down to the beach.', target: 'השביל מוביל במדרגות לחוף.' },
        sense_code: 'lead',
      },
    ],
  },
];

// `exact: true` throughout. The top card's example target is
// "היא טיפסה על הסולם.", which *contains* "סולם" — a substring match would find
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
  await expectGemini(request, { kind: 'word', entries: LADDER_ENTRIES });
  await openTranslate(page, request, 'e2e_translate_word');

  await page.getByTestId('translate-input').fill('ladder');
  await page.getByTestId('translate-submit').click();

  // The top sense only, with the other two behind `more`.
  await expect(sense(page, 'סולם')).toBeVisible();
  await expect(sense(page, 'דירוג')).toBeHidden();
  await expect(page.getByTestId('translate-more')).toContainText('2');

  await page.getByTestId('translate-more').click();
  await expect(sense(page, 'דירוג')).toBeVisible();
  await expect(sense(page, 'להוביל')).toBeVisible();

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
    entries: [
      {
        lemma: "I'm looking forward to seeing you",
        senses: [{ translation: 'אני מצפה לראות אותך.', sense_code: 'the_sentence' }],
      },
    ],
  });
  await openTranslate(page, request, 'e2e_translate_sentence');

  await page.getByTestId('translate-input').fill("I'm looking forward to seeing you");
  await page.getByTestId('translate-submit').click();

  await expect(sense(page, 'אני מצפה לראות אותך.')).toBeVisible();
  await expect(page.getByTestId('translate-more')).toHaveCount(0);
  await expect(page.getByTestId('translate-choose')).toHaveCount(0);
});

test('gibberish says so instead of inventing a translation', async ({ page, request }) => {
  await expectGemini(request, { kind: 'word', entries: [] });
  await openTranslate(page, request, 'e2e_translate_empty');

  await page.getByTestId('translate-input').fill('asdkjhasd');
  await page.getByTestId('translate-submit').click();

  await expect(page.getByTestId('translate-empty')).toHaveText('לא מצאנו תרגום');
});

test('a failing provider shows the error, and retry works once it recovers', async ({
  page,
  request,
}) => {
  // A different word from the word spec above, and not `ladder`: that spec has
  // already written `ladder` to the long-lived e2e database, and a second
  // lookup of it would answer from Postgres and never reach MockServer, which
  // would make this failing-provider assertion never fire.
  const ANCHOR_ENTRIES = [
    {
      lemma: 'anchor',
      senses: [
        {
          translation: 'עוגן',
          part_of_speech: 'noun',
          example: { source: 'The ship dropped anchor.', target: 'הספינה הטילה עוגן.' },
          sense_code: 'ship_anchor',
        },
      ],
    },
  ];

  await expectGeminiFailure(request, 500);
  await openTranslate(page, request, 'e2e_translate_retry');

  await page.getByTestId('translate-input').fill('anchor');
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-error')).toBeVisible();

  // Replacing the expectation is what makes this a test of retry *working*
  // rather than of the error state rendering.
  await clearGemini(request);
  await expectGemini(request, { kind: 'word', entries: ANCHOR_ENTRIES });

  await page.getByTestId('translate-retry').click();
  await expect(sense(page, 'עוגן')).toBeVisible();
});
