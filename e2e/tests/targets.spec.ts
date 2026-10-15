import { join } from 'node:path';

import type { PhotoImportSummary, Target, TargetList, VocabularyPage } from '@lang-tutor/core/api';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Response as PageResponse,
} from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapUntil } from './support/interactions';
import { clearGemini, expectGeminiMatching, userText } from './support/mockServer';
import { enrollmentIdOf } from './support/sessions';
import { openApp, signUpLearner } from './support/users';

// Phase 53 (spec D10, D11). The target wizard end to end on the web build: New, an exam, one
// photo of a word list, its review, a typed word and a date, then Done; home shows the target,
// and its screen removes a word, moves the date and ends it.
//
// Everything is stubbed at the model, as photo-import.spec.ts does it: the read of the photo,
// the lookup of each row, and the one typed lookup.
test.setTimeout(240_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

const PHOTO = join(__dirname, '..', 'fixtures', 'word-list.jpg');

// A lookup is stored in the e2e database for the rest of the run, and a word looked up in
// another spec would be served there from that spec's answer. So these four Italian words are
// in no other spec and not in the seed (photo-import.spec.ts keeps cane, banca and casa).
const lookupOf = (lemma: string, senses: { translation: string; sense_code: string }[]) => ({
  kind: 'word' as const,
  entries: [{ lemma, part_of_speech: 'noun', senses }],
});
const TAVOLO = lookupOf('tavolo', [{ translation: 'שולחן', sense_code: 'table' }]);

/**
 * The photo's three rows. The read answers them with the Hebrew printed beside each: the first
 * names its only sense, the second names none (so the model is asked which numbered sense, and
 * the row says what the list had), the third prints none and has two senses. Each answer is
 * matched by what is in its request, because the row jobs run four at a time.
 */
async function stubPhoto(request: APIRequestContext) {
  await expectGeminiMatching(request, 'read the word list in this photo', {
    items: [
      { text: 'sedia', hebrew: 'כיסא' },
      { text: 'strada', hebrew: 'רחוב' },
      { text: 'campo', hebrew: '' },
    ],
  });
  await expectGeminiMatching(request, 'which numbered sense', { sense: 0 });
  await expectGeminiMatching(
    request,
    userText('sedia'),
    lookupOf('sedia', [{ translation: 'כיסא', sense_code: 'chair' }]),
  );
  await expectGeminiMatching(
    request,
    userText('strada'),
    lookupOf('strada', [{ translation: 'כביש', sense_code: 'road' }]),
  );
  await expectGeminiMatching(
    request,
    userText('campo'),
    lookupOf('campo', [
      { translation: 'שדה', sense_code: 'field' },
      { translation: 'מחנה', sense_code: 'camp' },
    ]),
  );
}

// What the learner has, read over the API as the signed-in learner: `page.request` carries
// the cookie signUpLearner set (phase 29).
async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`);
  expect(res.ok(), `GET ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** The words of the learner's list, one lemma each. */
const savedLemmas = async (request: APIRequestContext, enrollmentId: string) =>
  (await read<VocabularyPage>(request, `/api/enrollments/${enrollmentId}/vocabulary`)).items
    .map((word) => word.lemma)
    .sort();
/** The photo imports still open: not saved, not discarded. */
const openImports = (request: APIRequestContext, enrollmentId: string) =>
  read<PhotoImportSummary[]>(request, `/api/enrollments/${enrollmentId}/photo-imports`);
const activeTargets = (request: APIRequestContext, enrollmentId: string) =>
  read<TargetList>(request, `/api/enrollments/${enrollmentId}/targets`);

/** Nothing is saved before Done: not a word, not a target, and the photo's import is open still. */
async function expectNothingSaved(request: APIRequestContext, enrollmentId: string) {
  const saved = await savedLemmas(request, enrollmentId);
  expect(saved, 'the typed word was saved before Done').not.toContain('tavolo');
  expect(saved).toEqual([]);
  expect((await activeTargets(request, enrollmentId)).targets).toEqual([]);
  expect(await openImports(request, enrollmentId)).toHaveLength(1);
}

// The writes the walk waits for. A tap flips the screen at once, so the screen proves nothing
// about the request: each is waited for, as tapAndWaitForWrite waits for a save.
const ITEM_URL = /\/api\/photo-imports\/[^/]+\/items\/\d+$/;
const CREATE_URL = /\/api\/enrollments\/[^/]+\/targets$/;
const TARGET_URL = /\/api\/targets\/[^/]+$/;
const WORD_URL = /\/api\/targets\/[^/]+\/words\/[^/]+$/;
const END_URL = /\/api\/targets\/[^/]+\/end$/;

async function tapAndWaitForResponse(
  page: Page,
  button: Locator,
  method: string,
  url: RegExp,
): Promise<PageResponse> {
  const answered = page.waitForResponse((res) => url.test(res.url()) && res.request().method() === method);
  await button.click();
  const res = await answered;
  expect(res.ok(), `${method} ${res.url()} answered ${res.status()}: ${await res.text()}`).toBe(true);
  return res;
}

// The labels draw their numbers inside Unicode isolates, so a label is matched by a regex where
// its numbers are, each one not part of a longer number.
const num = (value: number) => `(?<!\\d)${value}(?!\\d)`;
const readyOf = (ready: number, total: number) => new RegExp(`${num(ready)}\\D*מתוך\\D*${num(total)}\\D*מוכנות`);
const inDays = (days: number) => new RegExp(`בעוד\\D*${num(days)}\\D*ימים`);

/** The days the date step offers, tomorrow first: `wizard-date-YYYY-MM-DD`. Only those on
 *  show, so a screen kept hidden under another is not counted. */
const dateButtons = (page: Page) => page.locator('[data-testid^="wizard-date-"]:visible');

/** Picks the n-th day offered. Answers it, and the label its button wears, which is how the
 *  target screen words that day. */
async function pickDay(page: Page, index: number): Promise<{ day: string; label: string }> {
  const button = dateButtons(page).nth(index);
  const testId = await button.getAttribute('data-testid');
  const label = await button.textContent();
  if (!testId || !label) throw new Error(`the date step offers no day at ${index}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
  return { day: testId.slice('wizard-date-'.length), label };
}

test('an exam is prepared from a photo and a typed word; a word goes, the date moves and it ends', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  // Leaving the wizard with picks asks, and so does ending a target: window.confirm on the web.
  page.on('dialog', (dialog) => void dialog.accept());

  await signUpLearner(page, 'e2e_targets_walk', 'it');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubPhoto(request);
  const { today, targets: before } = await activeTargets(page.request, enrollmentId);
  expect(before).toEqual([]);

  // 1. New; the kind's button goes on by itself, to the photos.
  await tapUntil(page, 'target-new', 'wizard-kind-exam');
  await page.getByTestId('wizard-kind-exam').click();

  // 2. One photo from the gallery: the chooser is the browser's, answered with the fixture.
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('wizard-photo-choose').click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.getByTestId('wizard-photo-0'), report()).toBeVisible();
  await page.getByTestId('wizard-next').click();

  // 3. The review: the photo is its own import, read and looked up in the background.
  const rows = page.getByTestId('photo-import-row');
  await expect(rows, report()).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId('wizard-review-status')).toHaveCount(0, { timeout: 60_000 });
  await expect(rows.nth(0).getByTestId('photo-import-meaning')).toContainText('כיסא');
  await expect(rows.nth(1).getByTestId('photo-import-note')).toContainText('רחוב');
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('שדה');

  // The third row's other sense, and the second row unticked: each change goes to the server.
  await rows.nth(2).getByTestId('photo-import-meaning').click();
  await tapAndWaitForResponse(
    page,
    rows.nth(2).getByTestId('photo-import-option').filter({ hasText: 'מחנה' }),
    'PATCH',
    ITEM_URL,
  );
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('מחנה');
  await tapAndWaitForResponse(page, rows.nth(1).getByTestId('photo-import-tick'), 'PATCH', ITEM_URL);
  await expect(rows.nth(1).getByTestId('photo-import-tick')).toHaveAttribute('aria-checked', 'false');
  // Next waits for every import to settle and every change to land.
  await page.getByTestId('wizard-next').click();

  // 4. A typed word. In the wizard the card adds the word to the wizard's list and saves nothing.
  await lookUp(page, request, 'tavolo', TAVOLO);
  const add = page.getByTestId('translate-save');
  await expect(add).toHaveText('הוספה');
  await add.click();
  await expect(add).toHaveText('נוסף ✓');
  const chips = page.locator('[data-testid^="wizard-entry-"]:not([data-testid^="wizard-entry-remove-"])');
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText('tavolo');
  await expect(chips.first()).toContainText('שולחן');
  // Nothing was saved: not in the learner's list, and the app never asked to save a word.
  await expectNothingSaved(page.request, enrollmentId);
  expect(diagnostics.apiRequests.filter((sent) => /^POST \S+\/vocabulary$/.test(sent)), report()).toEqual([]);
  await page.getByTestId('wizard-next').click();

  // 5. The date: sixty days after the learner's today, never today itself. The first of them.
  await expect(dateButtons(page)).toHaveCount(60);
  await expect(page.getByTestId(`wizard-date-${today}`)).toHaveCount(0);
  const first = await pickDay(page, 0);
  expect(first.day > today, `${first.day} is not after ${today}`).toBe(true);
  await expectNothingSaved(page.request, enrollmentId);

  // 6. Done: one request saves the photo's ticked words and the typed word with the target.
  const created = await tapAndWaitForResponse(page, page.getByTestId('wizard-done'), 'POST', CREATE_URL);
  expect(created.status()).toBe(201);
  const target = (await created.json()) as Target;
  expect(target.kind).toBe('exam');
  expect(target.due_on).toBe(first.day);
  expect(target.words.map((word) => word.form).sort()).toEqual(['campo', 'sedia', 'tavolo']);
  // Now, and only now, the words are in the learner's list, the typed one among them, and the
  // photo's import is saved: no longer open. The unticked row was left out.
  const saved = await savedLemmas(page.request, enrollmentId);
  expect(saved).toContain('tavolo');
  expect(saved).toEqual(['campo', 'sedia', 'tavolo']);
  expect(await openImports(page.request, enrollmentId)).toEqual([]);

  // 7. The target's screen lists the ticked words and the typed one, with the date chosen.
  const wordOf = (form: string) => {
    const word = target.words.find((candidate) => candidate.form === form);
    if (!word) throw new Error(`the target holds no ${form}: ${JSON.stringify(target.words)}`);
    return word;
  };
  await expect(page.getByTestId('target-title'), report()).toHaveText('בוחן');
  await expect(page.getByTestId('target-due')).toHaveText(first.label);
  await expect(page.getByTestId('target-days-left')).toHaveText('מחר');
  await expect(page.getByTestId('target-ready')).toHaveText(readyOf(0, 3));
  await expect(page.getByTestId('target-word-readiness')).toHaveCount(3);
  await expect(page.getByTestId(`target-word-${wordOf('sedia').gloss_id}`)).toContainText('כיסא');
  await expect(page.getByTestId(`target-word-${wordOf('campo').gloss_id}`)).toContainText('מחנה');
  await expect(page.getByTestId(`target-word-${wordOf('tavolo').gloss_id}`)).toContainText('שולחן');

  // 8. Home shows the target: its kind, how soon, and how many words are ready.
  await page.getByTestId('target-back').click();
  const row = page.getByTestId(`target-row-${target.id}`);
  await expect(row, report()).toContainText('בוחן');
  await expect(row).toContainText('מחר');
  await expect(row).toContainText(readyOf(0, 3));

  // 9. Back on its screen, a word goes. It stays in the learner's list.
  await row.click();
  const sedia = wordOf('sedia');
  await expect(page.getByTestId(`target-word-${sedia.gloss_id}`)).toBeVisible();
  await tapAndWaitForResponse(page, page.getByTestId(`target-word-remove-${sedia.gloss_id}`), 'DELETE', WORD_URL);
  await expect(page.getByTestId(`target-word-${sedia.gloss_id}`)).toHaveCount(0);
  await expect(page.getByTestId('target-ready')).toHaveText(readyOf(0, 2));
  const removed = await read<Target>(page.request, `/api/targets/${target.id}`);
  expect(removed.words.map((word) => word.form).sort()).toEqual(['campo', 'tavolo']);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual(['campo', 'sedia', 'tavolo']);

  // 10. The date moves: the wizard offers its date step alone, and the screen shows the new day.
  await page.getByTestId('target-change-date').click();
  await expect(dateButtons(page)).toHaveCount(60);
  const later = await pickDay(page, 3);
  const moved = await tapAndWaitForResponse(page, page.getByTestId('wizard-done'), 'PATCH', TARGET_URL);
  expect(((await moved.json()) as Target).due_on).toBe(later.day);
  await expect(page.getByTestId('target-due'), report()).toHaveText(later.label);
  await expect(page.getByTestId('target-days-left')).toHaveText(inDays(4));

  // 11. Ending it asks first. Home no longer lists it, and its words stay saved.
  await tapAndWaitForResponse(page, page.getByTestId('target-end'), 'POST', END_URL);
  await expect(page.getByTestId('target-new')).toBeVisible();
  await expect(page.getByTestId(`target-row-${target.id}`)).toHaveCount(0);
  expect((await activeTargets(page.request, enrollmentId)).targets).toEqual([]);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual(['campo', 'sedia', 'tavolo']);

  // The app saved nothing itself: every word went in with the target.
  expect(diagnostics.apiRequests.filter((sent) => /^POST \S+\/vocabulary$/.test(sent)), report()).toEqual([]);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
