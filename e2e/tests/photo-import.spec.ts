import { join } from 'node:path';

import type { PhotoImportSummary, Target, TargetList, VocabularyPage } from '@lang-tutor/core/api';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { tapUntil } from './support/interactions';
import { clearGemini, expectGeminiMatching } from './support/mockServer';
import { enrollmentIdOf } from './support/sessions';
import { openApp, signUpLearner } from './support/users';

// Phase 64 (spec D8, R4, R12). One photo flow, from the header's camera: photos, their review,
// then what to do with the words: My words, a new prep, or a prep already open. It waits for
// its photos to be read, and leaving it discards them.
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
 *  example sentence). A later test here is served the first one's lookups from
 *  there, and only its match call reaches MockServer. */
async function stubImport(request: APIRequestContext) {
  await expectGeminiMatching(request, 'read the word list in this photo', {
    items: [
      { text: 'cane', hebrew: 'כלב' },
      { text: 'banca', hebrew: 'ספסל' },
      { text: 'casa', hebrew: '' },
    ],
  });
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

/** A second list, of two words in no other spec: a photo added to a prep already open. */
async function stubSecondImport(request: APIRequestContext) {
  await expectGeminiMatching(request, 'read the word list in this photo', {
    items: [
      { text: 'nuvola', hebrew: 'ענן' },
      { text: 'stella', hebrew: 'כוכב' },
    ],
  });
  await expectGeminiMatching(request, '"text":"nuvola"', lookupOf('nuvola', [{ translation: 'ענן', sense_code: 'cloud' }]));
  await expectGeminiMatching(request, '"text":"stella"', lookupOf('stella', [{ translation: 'כוכב', sense_code: 'star' }]));
}

const bodyOf = (res: { text(): Promise<string> }) => res.text().catch(() => '');
async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`);
  if (!res.ok()) throw new Error(`GET ${path} answered ${res.status()}: ${await bodyOf(res)}`);
  return (await res.json()) as T;
}
const savedLemmas = async (request: APIRequestContext, enrollmentId: string) =>
  (await read<VocabularyPage>(request, `/api/enrollments/${enrollmentId}/vocabulary`)).items.map((word) => word.lemma).sort();
const openImports = (request: APIRequestContext, enrollmentId: string) =>
  read<PhotoImportSummary[]>(request, `/api/enrollments/${enrollmentId}/photo-imports`);
const activeTargets = (request: APIRequestContext, enrollmentId: string) =>
  read<TargetList>(request, `/api/enrollments/${enrollmentId}/targets`);

/** From any tab: the header's camera, one photo from the gallery (the browser's chooser,
 *  answered with the fixture), and Next, which sends it. Answers the review's rows once the
 *  photo is read and every row looked up. */
async function reachReview(page: Page, rows: number): Promise<Locator> {
  await tapUntil(page, 'photo-entry', 'wizard-photo-choose');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('wizard-photo-choose').click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.getByTestId('wizard-photo-0')).toBeVisible();
  await page.getByTestId('wizard-next').click();
  const found = page.getByTestId('photo-import-row');
  await expect(found).toHaveCount(rows, { timeout: 60_000 });
  await expect(page.getByTestId('wizard-review-status')).toHaveCount(0, { timeout: 60_000 });
  return found;
}

/** Next from the review: the choice of what to do with the words. */
async function reachChoice(page: Page) {
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-step-title')).toHaveText('מה לעשות עם המילים החדשות?');
}

test('a photo of an Italian list goes to My words, as the review decided', async ({ page, request }) => {
  await signUpLearner(page, 'e2e_photo_it', 'it');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubImport(request);

  const rows = await reachReview(page, 3);
  await expect(rows.nth(0).getByTestId('photo-import-meaning')).toContainText('כלב');
  await expect(rows.nth(1).getByTestId('photo-import-note')).toContainText('ספסל');
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('בית');
  await rows.nth(2).getByTestId('photo-import-meaning').click();
  await rows.nth(2).getByTestId('photo-import-option').filter({ hasText: 'משפחה' }).click();
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('משפחה');
  await rows.nth(1).getByTestId('photo-import-tick').click();
  await expect(rows.nth(1).getByTestId('photo-import-tick')).toHaveAttribute('aria-checked', 'false');

  // Nothing is saved before the choice: the words wait in the photo's import.
  await reachChoice(page);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual([]);
  await page.getByTestId('wizard-dest-my-words').click();
  await expect(page.getByTestId('wizard-dest-my-words')).toHaveAttribute('aria-selected', 'true');
  // My words ends the flow: the choice is its last step.
  await page.getByTestId('wizard-done').click();

  // Back on תרגול with the count, and the two ticked words in מילים.
  await expect(page.getByTestId('home-photo-saved')).toContainText('נשמרו');
  // Phase 64b (spec D2): the notice sits above the cards, not under them.
  const notice = await page.getByTestId('home-photo-saved').boundingBox();
  const card = await page.getByTestId('home-my-words').boundingBox();
  expect((notice?.y ?? Infinity) + (notice?.height ?? 0)).toBeLessThanOrEqual(card?.y ?? -Infinity);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual(['cane', 'casa']);
  expect(await openImports(page.request, enrollmentId)).toEqual([]);
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  await expect(page.getByTestId('vocabulary-word')).toHaveCount(2);
  await expect(page.getByText('banca')).toHaveCount(0);
});

test('a photo makes a new exam, and a second photo joins it as a prep already open', async ({ page, request }) => {
  await signUpLearner(page, 'e2e_photo_prep', 'it');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubImport(request);

  // 1. A new exam: the choice goes on to more words and the date.
  await reachReview(page, 3);
  await reachChoice(page);
  await page.getByTestId('wizard-dest-exam').click();
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-step-title')).toHaveText('עוד מילים');
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-step-title')).toHaveText('באיזה תאריך?');
  await page.locator('[data-testid^="wizard-date-"]:visible').nth(4).click();
  await page.getByTestId('wizard-done').click();

  // Back on תרגול with the exam's card in the stack.
  await expect.poll(async () => (await activeTargets(page.request, enrollmentId)).targets.length).toBe(1);
  const [exam] = (await activeTargets(page.request, enrollmentId)).targets;
  expect(exam.kind).toBe('exam');
  expect(exam.word_count).toBe(3);
  await expect(page.getByTestId(`home-bar-${exam.id}`)).toBeVisible();

  // 2. A second photo, into the exam already open: the choice lists it, and Done adds the words.
  // The first photo's read stub would answer this read too: it goes first.
  await clearGemini(request);
  await stubSecondImport(request);
  await reachReview(page, 2);
  await reachChoice(page);
  const into = page.getByTestId(`wizard-dest-target-${exam.id}`);
  await expect(into).toContainText('בוחן');
  await into.click();
  await page.getByTestId('wizard-done').click();
  // The prep's own screen, with its five words.
  await expect(page.getByTestId('target-title')).toHaveText('בוחן');
  await expect(page.getByTestId('target-word-readiness')).toHaveCount(5);
  const after = await read<Target>(page.request, `/api/targets/${exam.id}`);
  expect(after.words.map((word) => word.form).sort()).toEqual(['banca', 'cane', 'casa', 'nuvola', 'stella']);
  expect(await openImports(page.request, enrollmentId)).toEqual([]);
});

test('leaving the flow asks first, then discards the photo it sent and saves nothing', async ({ page, request }) => {
  const said: string[] = [];
  page.on('dialog', (dialog) => {
    said.push(dialog.message());
    void dialog.accept();
  });
  await signUpLearner(page, 'e2e_photo_leave', 'it');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubImport(request);

  await reachReview(page, 3);
  expect(await openImports(page.request, enrollmentId)).toHaveLength(1);
  const discarded = page.waitForResponse(
    (res) => /\/api\/photo-imports\/[^/]+\/discard$/.test(res.url()) && res.request().method() === 'POST',
  );
  await page.getByTestId('wizard-cancel').click();
  expect((await discarded).status()).toBe(204);
  await expect(page.getByTestId('photo-entry')).toBeVisible();
  expect(said).toEqual(['לצאת בלי לשמור?\n\nהתמונות והמילים שנבחרו לא יישמרו.']);
  expect(await openImports(page.request, enrollmentId)).toEqual([]);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual([]);
});
