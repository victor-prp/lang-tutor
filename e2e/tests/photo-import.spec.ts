import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { tapUntil } from './support/interactions';
import { clearGemini, expectGeminiMatching } from './support/mockServer';
import { createLearner, logIn } from './support/users';

test.setTimeout(180_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

const PHOTO = join(__dirname, '..', 'fixtures', 'word-list.jpg');

const lookupOf = (lemma: string, senses: { translation: string; sense_code: string }[]) => ({
  kind: 'word',
  entries: [{ lemma, part_of_speech: 'noun', senses }],
});

/** The read answers three rows; each row's lookup and the one match call are
 *  matched by their bodies, because the jobs run four at a time.
 *
 *  The words are in no other spec and not in the seed. A lookup is stored in the
 *  e2e database for the rest of the run, so a word another spec also looks up
 *  would be served there from this answer (voice.spec.ts's `gatto` needs its
 *  example sentence). The second test below is served the first one's lookups
 *  from there, and only its match call reaches MockServer. */
async function stubImport(request: APIRequestContext, opts: { readDelayMs?: number } = {}) {
  await expectGeminiMatching(
    request,
    'read the word list in this photo',
    {
      items: [
        { text: 'cane', hebrew: 'כלב' },
        { text: 'banca', hebrew: 'ספסל' },
        { text: 'casa', hebrew: '' },
      ],
    },
    { delayMs: opts.readDelayMs },
  );
  await expectGeminiMatching(request, 'which numbered sense', { sense: 0 });
  await expectGeminiMatching(request, '"text":"cane"', lookupOf('cane', [{ translation: 'כלב', sense_code: 'dog' }]));
  await expectGeminiMatching(request, '"text":"banca"', lookupOf('banca', [{ translation: 'בנק', sense_code: 'bank' }]));
  await expectGeminiMatching(
    request,
    '"text":"casa"',
    lookupOf('casa', [
      { translation: 'בית', sense_code: 'house' },
      { translation: 'משפחה', sense_code: 'family' },
    ]),
  );
}

async function uploadFromGallery(page: Page) {
  await tapUntil(page, 'photo-import-entry', 'photo-import-choose');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('photo-import-choose').click();
  await (await chooser).setFiles(PHOTO);
}

test('a photo of an Italian list becomes three rows, and the review decides what is saved', async ({ page, request }) => {
  await createLearner(request, 'e2e_photo_it', 'it');
  await logIn(page, 'e2e_photo_it');
  await stubImport(request);
  await uploadFromGallery(page);

  const rows = page.getByTestId('photo-import-row');
  await expect(page.getByTestId('photo-import-status')).toHaveText('מוכן לסקירה', { timeout: 60_000 });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByTestId('photo-import-meaning')).toContainText('כלב');
  await expect(rows.nth(1).getByTestId('photo-import-note')).toContainText('ספסל');
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('בית');

  await rows.nth(2).getByTestId('photo-import-meaning').click();
  await rows.nth(2).getByTestId('photo-import-option').filter({ hasText: 'משפחה' }).click();
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('משפחה');
  await rows.nth(1).getByTestId('photo-import-tick').click();
  await expect(rows.nth(1).getByTestId('photo-import-tick')).toHaveAttribute('aria-checked', 'false');

  await page.getByTestId('photo-import-save').click();
  await expect(page.getByTestId('home-photo-saved')).toBeVisible();
  await expect(page.getByTestId('home-photo-card')).toHaveCount(0);

  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(2);
  await expect(page.getByText('banca')).toHaveCount(0);
});

test('leaving before the read finishes loses nothing: home shows the import, and it can be discarded', async ({ page, request }) => {
  await createLearner(request, 'e2e_photo_leave', 'it');
  await logIn(page, 'e2e_photo_leave');
  await stubImport(request, { readDelayMs: 5_000 });
  await uploadFromGallery(page);

  await expect(page.getByTestId('photo-import-status')).toHaveText('קוראים את התמונה…');
  await page.getByTestId('photo-import-review-back').click();
  const card = page.getByTestId('home-photo-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('3', { timeout: 60_000 });

  await card.click();
  await expect(page.getByTestId('photo-import-row')).toHaveCount(3);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('photo-import-discard').click();
  await expect(page.getByTestId('home-photo-card')).toHaveCount(0);
});
