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

// Two entries, not one: since phase 12 an entry is a LEXEME — a lemma together
// with a part of speech — so a single entry whose senses span noun and verb is
// no longer expressible, and the schema rejects it. The senses are the same
// three; what changed is which entry each belongs to.
//
// That also changes the order they arrive in, because the merge is round-robin
// across entries by rank: noun[0], verb[0], noun[1] — סולם, להוביל, דירוג. That
// order is what the word spec below asserts: the badge belongs to סולם, and the
// verb sense sits second on screen.
const LADDER_ENTRIES = [
  {
    lemma: 'ladder',
    part_of_speech: 'noun',
    senses: [
      {
        translation: 'סולם',
        example: { source: 'She climbed the ladder.', target: 'היא טיפסה על הסולם.' },
        sense_code: 'climbing_frame',
      },
      {
        translation: 'דירוג',
        example: { source: 'He moved up the corporate ladder.', target: 'הוא עלה בסולם הדרגות.' },
        sense_code: 'ranking',
      },
    ],
  },
  {
    lemma: 'ladder',
    part_of_speech: 'verb',
    senses: [
      {
        translation: 'להוביל',
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

test('a word shows every sense at once, ranked, and confirms a choice', async ({
  page,
  request,
}) => {
  await expectGemini(request, { kind: 'word', entries: LADDER_ENTRIES });
  await openTranslate(page, request, 'e2e_translate_word');

  await page.getByTestId('translate-input').fill('ladder');
  await page.getByTestId('translate-submit').click();

  // All three senses up front — one response, one screen, nothing behind a tap.
  await expect(sense(page, 'סולם')).toBeVisible();
  await expect(sense(page, 'להוביל')).toBeVisible();
  await expect(sense(page, 'דירוג')).toBeVisible();
  await expect(page.getByTestId('translate-count')).toHaveText('3 משמעויות');

  // Ranked, and only the first carries the badge: showing them together must
  // not cost the learner the signal about which one is the common meaning.
  await expect(page.getByTestId('translate-top-sense')).toHaveCount(1);
  await expect(page.getByTestId('translate-sense').first()).toContainText('סולם');

  await page.getByTestId('translate-choose').nth(1).click();
  await expect(page.getByTestId('translate-chosen')).toHaveText('התרגום נשמר לאוצר המילים שלך');
  await expect(page.getByTestId('translate-new-word')).toBeVisible();
});

test('a sentence gets one translation, with neither a count nor a save button', async ({
  page,
  request,
}) => {
  await expectGemini(request, {
    kind: 'sentence',
    entries: [
      {
        lemma: "I'm looking forward to seeing you",
        // Required by the schema and discarded for a sentence, which is never
        // written to the dictionary — the prompt says as much.
        part_of_speech: 'verb',
        senses: [{ translation: 'אני מצפה לראות אותך.', sense_code: 'the_sentence' }],
      },
    ],
  });
  await openTranslate(page, request, 'e2e_translate_sentence');

  await page.getByTestId('translate-input').fill("I'm looking forward to seeing you");
  await page.getByTestId('translate-submit').click();

  await expect(sense(page, 'אני מצפה לראות אותך.')).toBeVisible();
  // One translation, so neither the count line nor the save button: a count of
  // one is noise, and a sentence is known not to belong in a vocabulary.
  await expect(page.getByTestId('translate-count')).toHaveCount(0);
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
      part_of_speech: 'noun',
      senses: [
        {
          translation: 'עוגן',
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

test('a word looked up twice is answered without the provider the second time', async ({
  page,
  request,
}) => {
  const KITE_ENTRIES = [
    {
      lemma: 'kite',
      part_of_speech: 'noun',
      senses: [
        {
          translation: 'עפיפון',
          example: { source: 'The kite flew over the beach.', target: 'העפיפון עף מעל החוף.' },
          sense_code: 'flying_toy',
        },
        {
          translation: 'דיה',
          example: { source: 'A kite circled above the field.', target: 'דיה חגה מעל השדה.' },
          sense_code: 'bird_of_prey',
        },
      ],
    },
  ];

  await expectGemini(request, { kind: 'word', entries: KITE_ENTRIES });
  await openTranslate(page, request, 'e2e_translate_reuse');

  await page.getByTestId('translate-input').fill('kite');
  await page.getByTestId('translate-submit').click();
  await expect(sense(page, 'עפיפון')).toBeVisible();

  // Choosing is what reveals the "new word" control. It records nothing — as of
  // phase 10 the rows were written when the answer arrived, so the tap confirms
  // something that already happened.
  await page.getByTestId('translate-choose').first().click();
  await expect(page.getByTestId('translate-chosen')).toHaveText('התרגום נשמר לאוצר המילים שלך');
  await page.getByTestId('translate-new-word').click();

  // Nothing is left for the provider to answer with. An answer now can only
  // have come from Postgres.
  await clearGemini(request);

  await page.getByTestId('translate-input').fill('kite');
  await page.getByTestId('translate-submit').click();

  await expect(sense(page, 'עפיפון')).toBeVisible();
  await expect(sense(page, 'דיה')).toBeVisible();
  await expect(page.getByTestId('translate-error')).toHaveCount(0);
});

// Two one-shot expectations, and the count has to match the calls exactly.
// `thruot` makes ONE call because its corrected form `throat` is a lexeme nobody
// has stored, so phase 12's reconciliation never fires; tapping `throughout`
// makes one for the same reason. Both hold because neither word is among the
// thirteen strings in content.generated.ts and globalSetup drops and rebuilds
// lang_tutor_e2e every run — so the flow starts from the seed and nothing else.
//
// CHOOSE ANY REPLACEMENT WORD THE SAME WAY: a corrected form whose lexeme the
// seed already holds would make a second call and silently consume the
// expectation meant for the tap.
test('a misspelling shows the correction, and an alternative can be tapped', async ({
  page,
  request,
}) => {
  await expectGemini(
    request,
    {
      kind: 'word',
      entries: [
        {
          lemma: 'throat',
          part_of_speech: 'noun',
          senses: [
            {
              translation: 'גרון',
              example: { source: 'She had a sore throat.', target: 'היה לה כאב גרון.' },
              sense_code: 'body_part',
            },
          ],
        },
      ],
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
    },
    { once: true },
  );
  await expectGemini(
    request,
    {
      kind: 'word',
      entries: [
        {
          lemma: 'throughout',
          part_of_speech: 'preposition',
          senses: [
            {
              translation: 'בכל רחבי',
              example: { source: 'It rained throughout the day.', target: 'ירד גשם כל היום.' },
              sense_code: 'all_through',
            },
          ],
        },
      ],
    },
    { once: true },
  );
  await openTranslate(page, request, 'e2e_translate_correction');

  await page.getByTestId('translate-input').fill('thruot');
  await page.getByTestId('translate-submit').click();

  // The banner names both forms, and the answer is the corrected form's.
  const banner = page.getByTestId('translate-correction');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('thruot');
  await expect(banner).toContainText('throat');
  await expect(sense(page, 'גרון')).toBeVisible();

  // Tapping the chip is an ordinary lookup of that text — a FULL miss, so it
  // shows the loading skeleton for as long as any other new word does.
  await page.getByTestId('translate-alternative-0').click();
  await expect(sense(page, 'בכל רחבי')).toBeVisible();
  // And nothing is written for an alternative, so it carries no banner of its own.
  await expect(page.getByTestId('translate-correction')).toHaveCount(0);
  // The field agrees with the results it is showing — the setText half of the
  // handler, which is the half a bare submit() would have left stale.
  await expect(page.getByTestId('translate-input')).toHaveValue('throughout');
});

// The direction row's whole promise: what the box holds and what the label says
// are the same lookup. The control swaps the result INTO the box, so the next
// submit is the reverse lookup rather than a repeat of the first one — which is
// what the nightly QA agent caught (#29): a label that flipped, an input that
// did not, and a resubmit that quietly went back the way it came.
const directionLabel = (page: Page) => page.getByText(/^מ(אנגלית לעברית|עברית לאנגלית)$/);

test('swapping direction puts the translation in the box and looks it up in reverse', async ({
  page,
  request,
}) => {
  // Two one-shot expectations, consumed in registration order: the en_he lookup
  // of the typed word, then the he_en lookup of its translation. A word the seed
  // does not hold and no other spec here writes, so both calls are full misses
  // that reach MockServer — and a third call would find no expectation at all,
  // which is what makes the resubmit assertion below meaningful.
  await expectGemini(
    request,
    {
      kind: 'word',
      entries: [
        {
          lemma: 'hedgehog',
          part_of_speech: 'noun',
          senses: [
            {
              translation: 'קיפוד',
              example: { source: 'A hedgehog crossed the path.', target: 'קיפוד חצה את השביל.' },
              sense_code: 'spiny_animal',
            },
          ],
        },
      ],
    },
    { once: true },
  );
  await expectGemini(
    request,
    {
      kind: 'word',
      entries: [
        {
          lemma: 'קיפוד',
          part_of_speech: 'noun',
          senses: [
            {
              translation: 'hedgehog',
              example: { source: 'קיפוד חצה את השביל.', target: 'A hedgehog crossed the path.' },
              sense_code: 'spiny_animal',
            },
          ],
        },
      ],
    },
    { once: true },
  );
  await openTranslate(page, request, 'e2e_translate_swap');

  await page.getByTestId('translate-input').fill('hedgehog');
  await page.getByTestId('translate-submit').click();
  await expect(sense(page, 'קיפוד')).toBeVisible();
  await expect(directionLabel(page)).toHaveText('מאנגלית לעברית');

  await page.getByTestId('translate-flip').click();

  // The box holds the translation, the label describes the reverse direction,
  // and the senses are the reverse lookup's — three ways of saying one thing.
  await expect(page.getByTestId('translate-input')).toHaveValue('קיפוד');
  await expect(sense(page, 'hedgehog')).toBeVisible();
  await expect(directionLabel(page)).toHaveText('מעברית לאנגלית');

  // And it sticks. Submitting again from this state is the same he_en lookup,
  // answered from Postgres this time — not a silent revert to en_he, and not a
  // third provider call, which has no expectation left to answer it.
  await page.getByTestId('translate-submit').click();
  await expect(sense(page, 'hedgehog')).toBeVisible();
  await expect(directionLabel(page)).toHaveText('מעברית לאנגלית');
  await expect(page.getByTestId('translate-error')).toHaveCount(0);
});
