import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { expectGeneration } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { enrollmentIdOf, readyPathSession, skipSeed } from './support/sessions';
import {
  FILLED,
  HOMEWORK_WORDS,
  MET_DONE,
  OUTLINED,
  addDays,
  createTarget,
  expectLabel,
  expectReadiness,
  expectSessions,
  lookUpEntries,
  playSessionRight,
  readTarget,
  readTargets,
  showCard,
  type Word,
} from './support/targets';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

// Phase 72 (spec D2-D4). A target session's results screen shows what the home card shows, and its
// button opens the target's next session in its place, never passing through home. Once today is
// done it asks home's question first. On a device with no voice and no microphone, as the other
// target specs.
test.setTimeout(300_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

/** The creates the app sent: every session a target's button starts goes through one. */
const createsSent = (diagnostics: { apiRequests: string[] }) =>
  diagnostics.apiRequests.filter((sent) => /^POST \S+\/api\/sessions$/.test(sent)).length;

/** Home's reads of My words' session: home sends one each time it takes focus. */
const homeReads = (diagnostics: { apiRequests: string[] }) =>
  diagnostics.apiRequests.filter((sent) => /^GET \S+\/sessions\/current/.test(sent)).length;

/** Taps `button` until `shown` is on screen: a tap can find the path's next session still being
 *  prepared, when the button shows it so, disabled, until it is ready. Looks first, taps briefly. */
async function tapUntil(page: Page, button: string, shown: string) {
  const goal = page.getByTestId(shown).first();
  await expect(async () => {
    if (!(await goal.isVisible())) await page.getByTestId(button).click({ timeout: 2_000 });
    await expect(goal).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

/** A learner past the seed with a homework of `words`, due in `days`, its session ready, on home. */
async function homeworkOf(page: Page, request: APIRequestContext, username: string, words: readonly Word[], days: number) {
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  await skipSeed(page.request, enrollmentId);
  const entries = (await lookUpEntries(page.request, enrollmentId, words)).flat();
  await expectGeneration(request);
  const { today } = await readTargets(page.request, enrollmentId);
  const target = await createTarget(page.request, enrollmentId, { kind: 'homework', due_on: addDays(today, days), entries });
  await readyPathSession(page.request, enrollmentId, target.id);
  await openApp(page, `target-card-${target.id}`);
  await showCard(page, target.id);
  return { enrollmentId, target };
}

test('a homework session’s results show the card’s numbers, and continuing opens the next session without home', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  // Two days off, every word is met today: more than one session's work, so the day still owes after
  // the first.
  const { enrollmentId, target } = await homeworkOf(page, request, 'e2e_continue_owed', HOMEWORK_WORDS, 2);

  await tapUntil(page, `target-practice-${target.id}`, 'progress-label');
  await playSessionRight(page, request, HOMEWORK_WORDS);

  // The results screen: the card's readiness and today's line, from a read made after the session.
  const block = page.getByTestId('results-target');
  await expect(block, report()).toBeVisible();
  const after = await readTarget(page.request, target.id);
  expect(after.today, report()).toMatchObject({ state: 'owed', sessions_done: 1 });
  await expectReadiness(block, after);
  const sessions = block.getByTestId(`target-sessions-${target.id}`);
  await expect(sessions).toHaveAttribute('aria-label', /\S/);
  const sessionsSaid = await sessions.getAttribute('aria-label');
  const next = page.getByTestId('results-continue');
  await expectLabel(next, 'להמשיך לתרגל');
  await expect(next).toHaveCSS('background-color', FILLED);
  await expect(page.getByTestId('results-next-session')).toHaveCount(0);

  // Continue: the next session's first card, and home never took focus on the way.
  await readyPathSession(page.request, enrollmentId, target.id);
  const reads = homeReads(diagnostics);
  await tapUntil(page, 'results-continue', 'progress-label');
  await expect(page.getByTestId('progress-label')).toHaveText(/^\D*1\s*\/\s*\d+/);
  await expect(page.getByTestId('results-score')).toHaveCount(0);
  expect(homeReads(diagnostics), report()).toBe(reads);

  // Back from it is home, where the card says what the results screen said.
  await page.getByTestId('session-back').click();
  await expect(page.getByTestId('progress-label')).toBeHidden();
  await showCard(page, target.id);
  const card = page.getByTestId(`target-card-${target.id}`);
  await expectReadiness(card, after);
  await expect(card.getByTestId(`target-sessions-${target.id}`)).toHaveAttribute('aria-label', sessionsSaid!);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('once today is done, continuing asks home’s question first, and “אחזור מחר” goes home', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  // One word, 40 days off: its first session does the day's work, and nothing more today can raise
  // the card (as practice-more.spec.ts).
  const { target } = await homeworkOf(page, request, 'e2e_continue_done', [BOARD_WORDS[2]], 40);

  await tapUntil(page, `target-practice-${target.id}`, 'progress-label');
  await playSessionRight(page, request, [BOARD_WORDS[2]]);

  const block = page.getByTestId('results-target');
  const after = await readTarget(page.request, target.id);
  expect(after.today, report()).toMatchObject({ state: 'done', sessions_done: 1 });
  expect(after.practice_more_little, report()).toBe(true);
  await expectSessions(block, target.id, { ...MET_DONE, side: null, dots: ['done'] });
  await expectReadiness(block, after);
  const next = page.getByTestId('results-continue');
  await expectLabel(next, 'לתרגל עוד');
  await expect(next).toHaveCSS('background-color', OUTLINED);

  const creates = createsSent(diagnostics);
  await tapUntil(page, 'results-continue', 'practice-more-sheet');
  await expect(page.getByTestId('practice-more-sheet')).toContainText('עשית עבודה מצוינת להיום');
  await page.getByTestId('practice-more-later').click();
  await expect(page.getByTestId('results-score')).toBeHidden();
  await expect(page.getByTestId(`target-card-${target.id}`)).toBeVisible();
  await expect(page.getByTestId('progress-label')).toHaveCount(0);
  expect(createsSent(diagnostics), report()).toBe(creates);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
