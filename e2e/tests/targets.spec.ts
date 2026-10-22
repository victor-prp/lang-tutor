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
import { expectGeneration } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini, expectGeminiMatching, userText } from './support/mockServer';
import { answerSessionRight, enrollmentIdOf, readCurrent, readyPathSession, skipSeed } from './support/sessions';
import {
  ALL_READY,
  MET_MORE,
  EVERY_WORD,
  FILLED,
  HOMEWORK_WORDS,
  OUTLINED,
  addDays,
  createTarget,
  expectLabel,
  expectReadiness,
  expectSessions,
  metOf,
  formsOf,
  homeOrder,
  homework,
  lookUpEntries,
  moveDueDateToToday,
  makeTargetReady,
  moveTargetBack,
  eveOf,
  eveStrip,
  offerOf,
  playSessionRight,
  readTarget,
  readTargets,
  saveEntries,
  screenHeader,
  showCard,
} from './support/targets';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

// Phase 53 (spec D10, D11). The target wizard end to end on the web build. The first test is the
// walk: New, an exam, one photo of a word list, its review, a typed word and a date, then Done;
// home shows the target, and its screen removes a word, moves the date and ends it. The second
// leaves the wizard half way, with a photo uploaded; the third leaves it by the browser's back.
//
// Everything is stubbed at the model, as photo-import.spec.ts does it: the read of the photo,
// the lookup of each row, and the one typed lookup.
//
// Phase 57 (spec D1, D10–D12). The rest are a target's own path, made over the API: its card
// on home, first while work is owed; its session, of its words alone; the praise once the day
// is done, with My words first again; practice more; the target screen's groups and a word's
// skills; and the due date's good luck.
//
// Phase 65 (spec D4–D7). The card reads readiness as its big number, with today's gain on its
// bar, and today as a budget of sessions: the offer before the day's first session, then the
// sessions done, and once the day is done the line that says whether more practice can still raise
// the card (phase 67b, spec D7). The sheet before practising past the budget is practice-more.spec.ts.
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

/** What a response said, for a failure's message. A response with no body says nothing, and
 *  asking it for one can throw: Chromium has none to give for a 204. */
const bodyOf = (res: { text(): Promise<string> }) => res.text().catch(() => '');

// What the learner has, read over the API as the signed-in learner: `page.request` carries
// the cookie signUpLearner set (phase 29).
async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`);
  if (!res.ok()) throw new Error(`GET ${path} answered ${res.status()}: ${await bodyOf(res)}`);
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

// The writes the tests wait for, each with the status it answers. A tap flips the screen at
// once, so the screen proves nothing about the request: each is waited for, as
// tapAndWaitForWrite waits for a save.
type Write = { method: string; url: RegExp; status: number };
const ITEM_CHANGE: Write = { method: 'PATCH', url: /\/api\/photo-imports\/[^/]+\/items\/\d+$/, status: 200 };
const IMPORT_DISCARD: Write = { method: 'POST', url: /\/api\/photo-imports\/[^/]+\/discard$/, status: 204 };
const TARGET_CREATE: Write = { method: 'POST', url: /\/api\/enrollments\/[^/]+\/targets$/, status: 201 };
const WORD_REMOVE: Write = { method: 'DELETE', url: /\/api\/targets\/[^/]+\/words\/[^/]+$/, status: 204 };
const DATE_CHANGE: Write = { method: 'PATCH', url: /\/api\/targets\/[^/]+$/, status: 200 };
const TARGET_END: Write = { method: 'POST', url: /\/api\/targets\/[^/]+\/end$/, status: 204 };

/**
 * Taps, waits for the write the tap makes to be answered, and checks the status it answered.
 * The body is read only when the status is not the one expected: a 204 has none.
 */
async function tapAndWaitForResponse(page: Page, button: Locator, write: Write): Promise<PageResponse> {
  const answered = page.waitForResponse(
    (res) => write.url.test(res.url()) && res.request().method() === write.method,
  );
  await button.click();
  const res = await answered;
  if (res.status() !== write.status) {
    throw new Error(
      `${write.method} ${res.url()} answered ${res.status()}, not ${write.status}: ${await bodyOf(res)}`,
    );
  }
  return res;
}

/** Accepts every dialog the page opens (window.confirm on the web), and keeps what each said. */
function acceptDialogs(page: Page): string[] {
  const said: string[] = [];
  page.on('dialog', (dialog) => {
    said.push(dialog.message());
    void dialog.accept();
  });
  return said;
}

// What window.confirm shows for the app's confirm(): the title, a blank line, the message
// (apps/mobile/src/confirm.ts), worded as strings.ts words them.
const END_CONFIRM = 'לסיים את ההכנה?\n\nהמילים יישארו שמורות ברשימה שלך.';
const LEAVE_CONFIRM = 'לצאת בלי לשמור?\n\nהתמונות והמילים שנבחרו לא יישמרו.';

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

/**
 * Phase 64 (spec D8). From home: the header's camera, one photo from the gallery (the chooser
 * is the browser's, answered with the fixture), and Next, which sends the photo as its own
 * import. Answers the review's rows once the photo is read and every row looked up: the three
 * of stubPhoto. What the words are for is chosen after the review.
 */
async function reachReview(page: Page, report: () => string): Promise<Locator> {
  await tapUntil(page, 'photo-entry', 'wizard-photo-choose');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('wizard-photo-choose').click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.getByTestId('wizard-photo-0'), report()).toBeVisible();
  await page.getByTestId('wizard-next').click();
  const rows = page.getByTestId('photo-import-row');
  await expect(rows, report()).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId('wizard-review-status')).toHaveCount(0, { timeout: 60_000 });
  return rows;
}

test('an exam is prepared from a photo and a typed word; a word goes, the date moves and it ends', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  // Ending a target asks, and so would leaving the wizard holding picks: window.confirm on the web.
  const dialogs = acceptDialogs(page);

  await signUpLearner(page, 'e2e_targets_walk', 'it');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubPhoto(request);
  const { today, targets: before } = await activeTargets(page.request, enrollmentId);
  expect(before).toEqual([]);

  // 1. The review: the photo is its own import, read and looked up in the background.
  const rows = await reachReview(page, report);
  await expect(rows.nth(0).getByTestId('photo-import-meaning')).toContainText('כיסא');
  await expect(rows.nth(1).getByTestId('photo-import-note')).toContainText('רחוב');
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('שדה');

  // The third row's other sense, and the second row unticked: each change goes to the server.
  await rows.nth(2).getByTestId('photo-import-meaning').click();
  await tapAndWaitForResponse(
    page,
    rows.nth(2).getByTestId('photo-import-option').filter({ hasText: 'מחנה' }),
    ITEM_CHANGE,
  );
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('מחנה');
  await tapAndWaitForResponse(page, rows.nth(1).getByTestId('photo-import-tick'), ITEM_CHANGE);
  await expect(rows.nth(1).getByTestId('photo-import-tick')).toHaveAttribute('aria-checked', 'false');
  // Next waits for every import to settle and every change to land.
  await page.getByTestId('wizard-next').click();

  // 1b. What the words are for (phase 64, spec D8): a new exam, which goes on to more words.
  await expect(page.getByTestId('wizard-step-title')).toHaveText('מה לעשות עם המילים החדשות?');
  await page.getByTestId('wizard-dest-exam').click();
  await page.getByTestId('wizard-next').click();

  // 2. A typed word. In the wizard the card adds the word to the wizard's list and saves nothing.
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

  // 3. The date: sixty days after the learner's today, never today itself. The first of them.
  await expect(dateButtons(page)).toHaveCount(60);
  await expect(page.getByTestId(`wizard-date-${today}`)).toHaveCount(0);
  const first = await pickDay(page, 0);
  expect(first.day > today, `${first.day} is not after ${today}`).toBe(true);
  await expectNothingSaved(page.request, enrollmentId);

  // 4. Done: one request saves the photo's ticked words and the typed word with the target.
  const created = await tapAndWaitForResponse(page, page.getByTestId('wizard-done'), TARGET_CREATE);
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

  // 5. Done returns to home (phase 64, spec D8), whose card is the exam's: its kind, how soon,
  // and its readiness. Due tomorrow, the eve has no daily goal (phase 71, spec D4, D5): the card
  // counts the words still short with a bar a word, the fuse burns amber, and the strip says today
  // is for every word to be ready.
  const wordOf = (form: string) => {
    const word = target.words.find((candidate) => candidate.form === form);
    if (!word) throw new Error(`the target holds no ${form}: ${JSON.stringify(target.words)}`);
    return word;
  };
  const row = page.getByTestId(`target-row-${target.id}`);
  await expect(row, report()).toContainText('בוחן');
  await expect(row).toContainText('מחר');
  const offered = await read<Target>(page.request, `/api/targets/${target.id}`);
  expect(offered.today, report()).toMatchObject({ state: 'owed', sessions_budget: null, sessions_done: 0 });
  expect(offered.today.sessions_offer).toBeGreaterThan(0);
  expect(offered).toMatchObject({ readiness_pct: 0, readiness_start_pct: 0 });
  const card = page.getByTestId(`target-card-${target.id}`);
  await expectReadiness(card, offered);
  expect(offered.word_readiness, report()).toEqual([0, 0, 0]);
  await expectSessions(card, target.id, eveOf(offered));
  await expectLabel(page.getByTestId(`target-urgency-${target.id}`), eveStrip('exam'));
  await expect(page.getByTestId(`target-fuse-${target.id}`)).toHaveAttribute('aria-label', 'hot');

  // 6. Its screen lists the ticked words and the typed one, with the date chosen.
  // Phase 57 (spec D12): the header is the card's, and an exam due tomorrow plans every word
  // for today, so all three are owed. Phase 65 (spec D6): the card's readiness, and (phase 71) its
  // words row.
  await row.click();
  await expect(page.getByTestId('target-title'), report()).toHaveText('בוחן');
  await expect(page.getByTestId('target-due')).toHaveText(first.label);
  await expectLabel(page.getByTestId('target-countdown'), 'בוחן מחר');
  const header = screenHeader(page);
  await expectReadiness(header, offered);
  await expectSessions(header, target.id, eveOf(offered));
  await expect(page.getByTestId('target-word-readiness')).toHaveCount(3);
  await expect(page.getByTestId('target-group-owed')).toContainText('נשאר להיום');
  for (const form of ['campo', 'sedia', 'tavolo']) {
    await expect(page.getByTestId('target-group-owed').getByTestId(`target-word-${wordOf(form).gloss_id}`)).toBeVisible();
  }
  await expect(page.getByTestId(`target-word-${wordOf('sedia').gloss_id}`)).toContainText('כיסא');
  await expect(page.getByTestId(`target-word-${wordOf('campo').gloss_id}`)).toContainText('מחנה');
  await expect(page.getByTestId(`target-word-${wordOf('tavolo').gloss_id}`)).toContainText('שולחן');

  // 7. On its screen, a word goes. It stays in the learner's list.
  const sedia = wordOf('sedia');
  await expect(page.getByTestId(`target-word-${sedia.gloss_id}`)).toBeVisible();
  await tapAndWaitForResponse(page, page.getByTestId(`target-word-remove-${sedia.gloss_id}`), WORD_REMOVE);
  await expect(page.getByTestId(`target-word-${sedia.gloss_id}`)).toHaveCount(0);
  // Two words owe less than three: the offer is read again, and the header counts two words.
  const removed = await read<Target>(page.request, `/api/targets/${target.id}`);
  expect(removed.words.map((word) => word.form).sort()).toEqual(['campo', 'tavolo']);
  expect(removed.today.sessions_offer, report()).toBeLessThan(offered.today.sessions_offer);
  await expectSessions(header, target.id, eveOf(removed));
  expect(await savedLemmas(page.request, enrollmentId)).toEqual(['campo', 'sedia', 'tavolo']);

  // 8. The date moves: the wizard offers its date step alone, and the screen shows the new day.
  await page.getByTestId('target-change-date').click();
  await expect(dateButtons(page)).toHaveCount(60);
  const later = await pickDay(page, 3);
  const moved = await tapAndWaitForResponse(page, page.getByTestId('wizard-done'), DATE_CHANGE);
  expect(((await moved.json()) as Target).due_on).toBe(later.day);
  await expect(page.getByTestId('target-due'), report()).toHaveText(later.label);
  await expectLabel(page.getByTestId('target-countdown'), 'בוחן בעוד 4 ימים');

  // 9. Ending it asks first. Home no longer lists it, and its words stay saved.
  await tapAndWaitForResponse(page, page.getByTestId('target-end'), TARGET_END);
  await expect(page.getByTestId('photo-entry')).toBeVisible();
  await expect(page.getByTestId(`target-row-${target.id}`)).toHaveCount(0);
  expect((await activeTargets(page.request, enrollmentId)).targets).toEqual([]);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual(['campo', 'sedia', 'tavolo']);

  // That was the one question the walk was asked: it never left the wizard holding picks.
  expect(dialogs).toEqual([END_CONFIRM]);
  // The app saved nothing itself: every word went in with the target.
  expect(diagnostics.apiRequests.filter((sent) => /^POST \S+\/vocabulary$/.test(sent)), report()).toEqual([]);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('cancelling the wizard asks first, then discards the photo it sent and saves nothing', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const dialogs = acceptDialogs(page);

  await signUpLearner(page, 'e2e_targets_cancel', 'it');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubPhoto(request);

  // The wizard holds a photo, and the photo's import is open on the server.
  await reachReview(page, report);
  expect(await openImports(page.request, enrollmentId)).toHaveLength(1);

  // Cancel asks, since a photo is held; the answer is yes. The import is discarded before the
  // wizard leaves, so once home shows nothing is left to wait for.
  await tapAndWaitForResponse(page, page.getByTestId('wizard-cancel'), IMPORT_DISCARD);
  await expect(page.getByTestId('photo-entry'), report()).toBeVisible();
  expect(dialogs).toEqual([LEAVE_CONFIRM]);
  expect(await openImports(page.request, enrollmentId)).toEqual([]);
  expect((await activeTargets(page.request, enrollmentId)).targets).toEqual([]);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual([]);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('leaving the wizard by the browser’s back, not its Cancel, discards the photo it sent all the same', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const dialogs = acceptDialogs(page);

  await signUpLearner(page, 'e2e_targets_back', 'it');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubPhoto(request);

  await reachReview(page, report);
  expect(await openImports(page.request, enrollmentId)).toHaveLength(1);

  // Final review I2. The browser's back unmounts the wizard without its Cancel, as a reminder's
  // tap does on a phone: nothing asks, and the import is discarded on the way out.
  const discarded = page.waitForResponse(
    (res) => IMPORT_DISCARD.url.test(res.url()) && res.request().method() === IMPORT_DISCARD.method,
  );
  await page.goBack();
  expect((await discarded).status(), report()).toBe(IMPORT_DISCARD.status);
  await expect(page.getByTestId('photo-entry'), report()).toBeVisible();
  expect(dialogs).toEqual([]);
  expect(await openImports(page.request, enrollmentId)).toEqual([]);
  expect((await activeTargets(page.request, enrollmentId)).targets).toEqual([]);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual([]);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

/** Final review C1. The creates the app sent: a target's button goes through one before it
 *  enters an unstarted stock, so the server can replace a stock that no longer serves the day. */
const createsSent = (diagnostics: { apiRequests: string[] }) =>
  diagnostics.apiRequests.filter((sent) => /^POST \S+\/api\/sessions$/.test(sent)).length;

/** Results lead home, where every card is read again. */
async function backHome(page: Page) {
  await page.getByTestId('results-next-session').click();
  await expect(page.getByTestId('results-score')).toBeHidden();
}

test('a new homework comes first with practice now, which asks its words alone; once they are done My words leads', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const { enrollmentId, target } = await homework(page, request, 'e2e_paths_practise');
  const stock = await readyPathSession(page.request, enrollmentId, target.id);
  await openApp(page, `target-card-${target.id}`);

  // 1. Work is owed today: the homework's card is first, its button filled. Phase 65 (spec D5):
  // nothing answered yet, readiness is 0 with no gain on its bar, and today is the offer.
  const practice = page.getByTestId(`target-practice-${target.id}`);
  const card = page.getByTestId(`target-card-${target.id}`);
  await expect.poll(() => homeOrder(page), { message: report() }).toEqual([target.id, 'main']);
  await expectLabel(page.getByTestId(`target-countdown-${target.id}`), '40 ימים');
  const offered = await readTarget(page.request, target.id);
  expect(offered.today, report()).toMatchObject({ state: 'owed', sessions_budget: null, sessions_done: 0 });
  await expectReadiness(card, offered);
  await expectSessions(card, target.id, offerOf(offered.today));
  await expect(page.getByTestId(`target-praise-${target.id}`)).toHaveCount(0);
  await expectLabel(practice, 'לתרגל עכשיו');
  await expect(practice).toHaveCSS('background-color', FILLED);
  // My words is the stack's second card (phase 64, spec D3): its dot brings it up.
  // Phase 64 (spec D4): its button is solid too, since pressing it starts a session.
  await showCard(page, 'main');
  await expect(page.getByTestId('start-button'), report()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('start-button')).toHaveCSS('background-color', FILLED);
  await showCard(page, target.id);

  // 2. Practice now enters the homework's own session, through create (final review C1), which
  // answers the stock as it is: it asks the word owed today, a new word's ladder, and no word of
  // the learner's own list.
  const before = createsSent(diagnostics);
  await tapUntil(page, `target-practice-${target.id}`, 'progress-label');
  expect(createsSent(diagnostics), report()).toBeGreaterThan(before);
  expect((await readCurrent(page.request, enrollmentId, target.id)).current?.session_id).toBe(stock);

  // Final review N1. Left before any answer, once its start has landed: started with none. Home
  // resumes it on the next tap, with no create (which would answer session_open).
  await expect
    .poll(async () => (await readCurrent(page.request, enrollmentId, target.id)).current?.started, { message: report() })
    .toBe(true);
  // The tap waits for home's own read of the targets since it came back, and its render: a tap
  // on the list home held from before the start goes through create, which answers
  // session_open, and home recovers by entering the session (final review N1). That recovery
  // is by design; this step is about the list read since, which resumes with no create.
  const reread = page.waitForResponse(
    async (res) =>
      res.request().method() === 'GET' &&
      res.url().endsWith(`/api/enrollments/${enrollmentId}/targets`) &&
      ((await res.json()) as TargetList).targets.find((t) => t.id === target.id)?.session?.started === true,
  );
  await page.getByTestId('session-back').click();
  await reread;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(practice, report()).toBeVisible();
  const resumed = createsSent(diagnostics);
  await tapUntil(page, `target-practice-${target.id}`, 'progress-label');
  expect(createsSent(diagnostics), report()).toBe(resumed);
  expect((await readCurrent(page.request, enrollmentId, target.id)).current).toMatchObject({ session_id: stock, answered: 0, started: true });
  const asked = await playSessionRight(page, request, EVERY_WORD);
  expect([...new Set(asked)].sort(), asked.join(', ')).toEqual(formsOf(target, 'owed'));

  // 3. Every owed word is done: the card says the day is done, and it moves below My words,
  // whose button is now the filled one; its own offers practice more, outlined. Back on home the
  // stack shows its first card, now My words (Review Focus 3).
  // Phase 65 (spec D5, D7): the session set the day's budget as it started, the offer then. Phase
  // 67 (spec D5): the budget is the day itself, one session, so the day is met, not ended early.
  // Readiness rose from 0, and its bar says by how much today.
  await backHome(page);
  await expect.poll(() => homeOrder(page), { message: report() }).toEqual(['main', target.id]);
  await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('start-button')).toHaveCSS('background-color', FILLED);
  await showCard(page, target.id);
  const done = await readTarget(page.request, target.id);
  expect(done.today, report()).toMatchObject({
    state: 'done',
    done: 1,
    planned: 1,
    extra: 0,
    sessions_budget: 1,
    sessions_done: 1,
    ended_early: false,
  });
  expect(offered.today.sessions_offer).toBe(1);
  expect(done.readiness_pct).toBeGreaterThan(0);
  expect(done.readiness_start_pct).toBe(0);
  // Phase 67b (spec D6, D7): later words are left to meet, so another session can raise the card.
  expect(done.practice_more_little, report()).toBe(false);
  await expectSessions(card, target.id, { ...MET_MORE, side: null, dots: ['done'] });
  await expectReadiness(card, done);
  await expectLabel(practice, 'לתרגל עוד');
  await expect(practice).toHaveCSS('background-color', OUTLINED);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('practice more starts the next words early, and the target screen groups them and opens a word’s skills', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const { enrollmentId, target } = await homework(page, request, 'e2e_paths_more');

  // Today's owed work, answered over the API; the path's next session is practice more. Its
  // first answer started it (no start call), which set the day's budget (phase 65, spec D7.1).
  await answerSessionRight(page.request, await readyPathSession(page.request, enrollmentId, target.id));
  const before = await readTarget(page.request, target.id);
  expect(before.today).toMatchObject({ state: 'done', done: 1, planned: 1, extra: 0, sessions_done: 1, ended_early: false });
  const budget = before.today.sessions_budget;
  if (budget === null) throw new Error(`the first answer set no budget: ${JSON.stringify(before.today)}`);
  // Phase 67 (spec D5): the day's owed work, one ladder, is one session of the play, and the budget
  // is the play. The practice-more session below is past it: a bonus.
  expect(budget).toBe(1);
  // Phase 67b (spec D6, D8): later words are left to meet, so practice more can raise the card and
  // its button starts at once, with no sheet.
  expect(before.practice_more_little).toBe(false);
  const more = await readyPathSession(page.request, enrollmentId, target.id);
  // Done for today, the homework is under My words: its dot, not its card, is on show.
  await openApp(page, `home-bar-${target.id}`);

  // 1. Done for today: the card is below My words, and its button starts another session of
  // the homework, which starts later words early and asks only the homework's words. It goes
  // through create, which keeps the practice-more stock: the day owes nothing it would serve.
  const practice = page.getByTestId(`target-practice-${target.id}`);
  await expect.poll(() => homeOrder(page), { message: report() }).toEqual(['main', target.id]);
  await showCard(page, target.id);
  await expectLabel(practice, 'לתרגל עוד');
  await tapUntil(page, `target-practice-${target.id}`, 'progress-label');
  await expect(page.getByTestId('practice-more-sheet')).toHaveCount(0);
  expect(createsSent(diagnostics), report()).toBeGreaterThan(0);
  expect((await readCurrent(page.request, enrollmentId, target.id)).current?.session_id).toBe(more);
  const asked = await playSessionRight(page, request, EVERY_WORD);
  const homeworkForms = HOMEWORK_WORDS.map((word) => word.form);
  for (const form of asked) expect(homeworkForms, asked.join(', ')).toContain(form);

  // 2. The words it started are today's extra. Phase 65 (spec D5, D7): the day is still done, and
  // its second session is a bonus past the budget; readiness rose with the words started.
  await backHome(page);
  const after = await readTarget(page.request, target.id);
  expect(after.today, report()).toMatchObject({ state: 'done', done: 1, planned: 1, extra: 2, sessions_budget: budget, sessions_done: 2, ended_early: false });
  expect(after.readiness_pct).toBeGreaterThan(before.readiness_pct);
  const extra = formsOf(after, 'extra');
  for (const form of extra) expect(asked).toContain(form);
  await showCard(page, target.id);
  // Still words to meet: the blue line, the session past the budget a bonus.
  expect(after.practice_more_little, report()).toBe(false);
  const sessions = { ...MET_MORE, side: '+1 בונוס', dots: ['done', 'bonus'] };
  await expectSessions(page.getByTestId(`target-card-${target.id}`), target.id, sessions);
  await expectReadiness(page.getByTestId(`target-card-${target.id}`), after);

  // 3. The target screen: the card's header, then its words in groups, each with its line.
  await page.getByTestId(`target-row-${target.id}`).click();
  await expectLabel(page.getByTestId('target-countdown'), 'שיעורי בית בעוד 40 ימים');
  const header = screenHeader(page);
  await expectSessions(header, target.id, sessions);
  await expectReadiness(header, after);
  await expect(page.getByTestId('target-group-owed')).toHaveCount(0);
  const groups = { done: ['תורגלו היום', 1], extra: ['נוספו היום', 2], later: ['בהמשך', 3] } as const;
  for (const [today, [title, count]] of Object.entries(groups)) {
    const group = page.getByTestId(`target-group-${today}`);
    await expect(group, report()).toContainText(title);
    const words = after.words.filter((word) => word.today === today);
    expect(words, today).toHaveLength(count);
    for (const word of words) {
      await expect(group.getByTestId(`target-word-${word.gloss_id}`)).toContainText(word.form);
      const later = word.starts_in === 1 ? 'נתחיל מחר' : `נתחיל בעוד ${word.starts_in} ימים`;
      const line = today === 'done' ? 'היום ✓' : today === 'extra' ? 'בונוס ✓' : later;
      await expectLabel(page.getByTestId(`target-word-today-${word.gloss_id}`), line);
    }
  }

  // 4. A tapped word opens the skills its readiness counts (phase 65, spec D1, D6): homework's
  // writing and spelling on a device with no voice and no microphone (speaking is not live), each
  // its chance out of 100 on the date; recognition never counts. Tapped again, they close.
  const [word] = after.words.filter((candidate) => candidate.today === 'done');
  const skills = page.getByTestId(`target-word-skills-${word.gloss_id}`);
  await expect(skills).toHaveCount(0);
  await page.getByTestId(`target-word-toggle-${word.gloss_id}`).click();
  await expect(skills).toBeVisible();
  for (const name of ['כתיבה', 'איות']) await expect(skills).toContainText(name);
  for (const name of ['זיהוי בכתב', 'הבנת הנשמע', 'דיבור']) await expect(skills).not.toContainText(name);
  expect(word.skills.map((skill) => skill.dimension).sort()).toEqual(['spelling', 'written_productive']);
  const names: Record<string, string> = { written_productive: 'כתיבה', spelling: 'איות' };
  for (const skill of word.skills) {
    expect(skill.chance, skill.dimension).toBeGreaterThan(0);
    expect(skill.held, skill.dimension).toBe(false);
    await expectLabel(skills.getByTestId(`target-word-skill-${skill.dimension}`), `${names[skill.dimension]}${skill.chance}%`);
  }
  await page.getByTestId(`target-word-toggle-${word.gloss_id}`).click();
  await expect(skills).toHaveCount(0);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('home orders its paths: the exam due today first with good luck, then work owed, My words, then done and resting', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_paths_order', 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  await skipSeed(page.request, enrollmentId);
  // One word each: My words', the exam's, and three homeworks'.
  const [mine, examWord, owedWord, doneWord, restWord] = await lookUpEntries(page.request, enrollmentId, BOARD_WORDS.slice(0, 5));
  await expectGeneration(request);
  await saveEntries(page.request, enrollmentId, mine);
  const { today } = await readTargets(page.request, enrollmentId);
  const make = (kind: 'exam' | 'homework', days: number, entries: typeof mine) =>
    createTarget(page.request, enrollmentId, { kind, due_on: addDays(today, days), entries });
  const exam = await make('exam', 1, examWord);
  const owed = await make('homework', 40, owedWord);
  const done = await make('homework', 41, doneWord);
  const resting = await make('homework', 42, restWord);
  // Done: its one word is today's, answered right. Resting: the same, two days ago, and ready
  // since (phase 67, spec D2: a ready word rests before the eve), so nothing is owed today and
  // nothing was practised.
  for (const target of [done, resting]) {
    await answerSessionRight(page.request, await readyPathSession(page.request, enrollmentId, target.id));
  }
  await moveTargetBack(resting.id, 2);
  await makeTargetReady(resting.id);
  // The exam was due tomorrow; now it is today (spec D10: active through its date).
  await readyPathSession(page.request, enrollmentId, exam.id);
  await moveDueDateToToday(exam.id, today);
  const { targets } = await readTargets(page.request, enrollmentId);
  const summaryOf = (id: string) => {
    const found = targets.find((target) => target.id === id);
    if (!found) throw new Error(`home lists no target ${id}: ${JSON.stringify(targets)}`);
    return found;
  };
  const stateOf = (id: string) => summaryOf(id).today;
  const cardOf = (id: string) => page.getByTestId(`target-card-${id}`);
  expect(targets.map((target) => [target.id, target.today.state]), report()).toEqual(
    expect.arrayContaining([
      [exam.id, 'due_today'],
      [owed.id, 'owed'],
      [done.id, 'done'],
      [resting.id, 'rest'],
    ]),
  );
  await openApp(page, `target-card-${exam.id}`);

  // 1. The order (spec D11), the date first (D10).
  await expect.poll(() => homeOrder(page), { message: report() }).toEqual([exam.id, owed.id, 'main', done.id, resting.id]);
  const practice = (id: string) => page.getByTestId(`target-practice-${id}`);
  // Phase 64 (spec D3, D4): one card at a time, each brought up by its dot; a button is solid
  // when pressing it is the thing to do now, so the owed homework's is solid too.
  await showCard(page, 'main');
  await expect(page.getByTestId('start-button'), report()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('start-button')).toHaveCSS('background-color', FILLED);
  for (const id of [done.id, resting.id]) {
    await showCard(page, id);
    await expect(practice(id)).toHaveCSS('background-color', OUTLINED);
  }
  await showCard(page, owed.id);
  await expect(practice(owed.id)).toHaveCSS('background-color', FILLED);
  await showCard(page, exam.id);

  // 2. On its date the exam says so and wishes good luck; nothing is owed, so there is no
  // sessions line (phase 65, spec D5), and its button is the optional last review, filled while
  // not yet ready.
  await expectLabel(page.getByTestId(`target-countdown-${exam.id}`), 'היום');
  await expectLabel(page.getByTestId(`target-due-today-${exam.id}`), 'בהצלחה!');
  // On its date with its word not ready, the card says so (phase 64, spec D5).
  await expectLabel(
    page.getByTestId(`target-urgency-${exam.id}`),
    'הבוחן היום ומילה אחת צריכה חיזוק',
  );
  await expect(page.getByTestId(`target-sessions-${exam.id}`)).toHaveCount(0);
  expect(summaryOf(exam.id)).toMatchObject({ readiness_pct: 0, readiness_start_pct: 0 });
  await expectReadiness(cardOf(exam.id), summaryOf(exam.id));
  await expectLabel(practice(exam.id), 'חזרה אחרונה');
  await expect(practice(exam.id)).toHaveCSS('background-color', FILLED);

  // 3. The owed homework calls to practise now, today's sessions offered; the done one says the
  // day is done, the budget its first answer set met (phase 65, spec D7; phase 67, spec D5); the
  // resting one says when it practises next, with no sessions line. Both offer practice more.
  await showCard(page, owed.id);
  await expectLabel(practice(owed.id), 'לתרגל עכשיו');
  expect(stateOf(owed.id)).toMatchObject({ sessions_budget: null, sessions_done: 0 });
  await expectSessions(cardOf(owed.id), owed.id, offerOf(stateOf(owed.id)));
  await showCard(page, done.id);
  const doneBudget = stateOf(done.id).sessions_budget;
  expect(stateOf(done.id), report()).toMatchObject({ sessions_done: 1, sessions_budget: 1, ended_early: false });
  if (doneBudget === null) throw new Error(`the first answer set no budget: ${JSON.stringify(stateOf(done.id))}`);
  await expectSessions(cardOf(done.id), done.id, { ...metOf(summaryOf(done.id)), side: null, dots: ['done'] });
  await expectLabel(practice(done.id), 'לתרגל עוד');
  const next = stateOf(resting.id).next_practice_in;
  expect(next, report()).toBeGreaterThan(1);
  await showCard(page, resting.id);
  await expectLabel(
    page.getByTestId(`target-rest-${resting.id}`),
    `היום אין תרגול לשיעורי הבית. התרגול הבא בעוד ${next} ימים`,
  );
  // Phase 67b (spec D7): its word ready, the card at 100% says so on the rest day too.
  expect(summaryOf(resting.id).readiness_pct, report()).toBe(100);
  await expectSessions(cardOf(resting.id), resting.id, { ...ALL_READY, side: null, dots: [] });
  await expectLabel(practice(resting.id), 'לתרגל עוד');

  // 4. The exam's screen says the same, and offers no change: the date has come. Nothing is
  // owed on it (final review M1): its word is listed with no group title and no line for today.
  await showCard(page, exam.id);
  await page.getByTestId(`target-row-${exam.id}`).click();
  await expectLabel(page.getByTestId('target-countdown'), 'הבוחן היום');
  await expectReadiness(screenHeader(page), summaryOf(exam.id));
  await expect(screenHeader(page).getByTestId(`target-sessions-${exam.id}`)).toHaveCount(0);
  const [examOnly] = exam.words;
  await expect(page.getByTestId('target-group-all').getByTestId(`target-word-${examOnly.gloss_id}`), report()).toBeVisible();
  await expect(page.getByTestId('target-group-owed')).toHaveCount(0);
  await expect(page.getByText('נשאר להיום')).toHaveCount(0);
  await expect(page.getByTestId(`target-word-today-${examOnly.gloss_id}`)).toHaveCount(0);
  await expect(page.getByTestId('target-change-date')).toHaveCount(0);
  await expect(page.getByTestId('target-end')).toHaveCount(0);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
