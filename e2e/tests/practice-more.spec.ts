import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { expectGeneration } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { enrollmentIdOf, readyPathSession, skipSeed } from './support/sessions';
import {
  MET_DONE,
  addDays,
  createTarget,
  expectLabel,
  expectReadiness,
  expectSessions,
  lookUpEntries,
  offerOf,
  playSessionRight,
  readTarget,
  readTargets,
  showCard,
} from './support/targets';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

// Phase 65 (spec D7, D9), phase 65b (spec D1). Practising once today reads done. A homework of one
// word, on a device with no voice and no microphone, so its readiness counts writing and spelling:
// its first session, entered at once, does the day's work and meets the budget, the day itself
// (phase 67, spec D5). Phase 67b (spec D6, D8): its one word met and both its skills answered
// today, 40 days before the date, no session today can raise the card, so "לתרגל עוד" asks first. "אחזור מחר" closes the sheet, "לתרגל
// בכל זאת" starts a bonus session past the budget, the tick box stops the asking (the next is a
// second bonus), and the switch in הגדרות, which reads the choice each time it is shown, brings it
// back.
test.setTimeout(300_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

/** The word the homework holds: a single-sense noun shared with other specs (lexemes.ts). */
const WORD = BOARD_WORDS[2];

/** The creates the app sent: every session a target's button starts goes through one. */
const createsSent = (diagnostics: { apiRequests: string[] }) =>
  diagnostics.apiRequests.filter((sent) => /^POST \S+\/api\/sessions$/.test(sent)).length;

/**
 * Taps the target's button until `shown` is on screen: the session's counter, or the sheet. Not
 * tapUntil, whose every try taps: a tap can find the path's stock stale (it was chosen while the
 * day still owed work), so create answers its replacement preparing and the card shows it so,
 * disabled, until it is ready to tap again; and by then home can be under the session already. So
 * each try looks first and taps only briefly.
 */
async function tapCardUntil(page: Page, targetId: string, shown: string) {
  const goal = page.getByTestId(shown).first();
  await expect(async () => {
    if (!(await goal.isVisible())) await page.getByTestId(`target-practice-${targetId}`).click({ timeout: 2_000 });
    await expect(goal).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

/** Plays the session on screen right to its end, and returns home from its results, once the
 *  path's next session is ready (home's button is not pressable while it is prepared). */
async function playAndReturn(page: Page, request: APIRequestContext, enrollmentId: string, targetId: string) {
  await playSessionRight(page, request, [WORD]);
  // Phase 72 (spec D3): a target session's results continue on its path; סיום goes home.
  await page.getByTestId('results-done').click();
  await expect(page.getByTestId('results-score')).toBeHidden();
  await readyPathSession(page.request, enrollmentId, targetId);
  await showCard(page, targetId);
}

test('past the day’s budget, practice more asks first; the tick box stops the asking, and הגדרות brings it back', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_practice_more', 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  await skipSeed(page.request, enrollmentId);
  const [entries] = await lookUpEntries(page.request, enrollmentId, [WORD]);
  await expectGeneration(request);
  const { today } = await readTargets(page.request, enrollmentId);
  const target = await createTarget(page.request, enrollmentId, { kind: 'homework', due_on: addDays(today, 40), entries });
  await readyPathSession(page.request, enrollmentId, target.id);
  await openApp(page, `target-card-${target.id}`);

  const card = page.getByTestId(`target-card-${target.id}`);
  const practice = page.getByTestId(`target-practice-${target.id}`);
  const sheet = page.getByTestId('practice-more-sheet');
  const tick = page.getByTestId('practice-more-stop-asking');

  // 1. Before the day's first session the card offers the budget. The offer is what the first
  // session's start sets: the word's ladder does the day's work in one session, and the budget is
  // that play, with no room for misses (phase 67, spec D5).
  const offered = await readTarget(page.request, target.id);
  expect(offered.today, report()).toMatchObject({ state: 'owed', sessions_budget: null, sessions_done: 0 });
  const budget = offered.today.sessions_offer;
  expect(budget, report()).toBe(1);
  await expectSessions(card, target.id, offerOf(offered.today));

  // 2. The first session, straight in from the card: while the day owes work nothing asks. It does
  // the day's work (the word's ladder, every answer right), so the day reads done, the budget met
  // (spec D5, D7).
  const creates1 = createsSent(diagnostics);
  await tapCardUntil(page, target.id, 'progress-label');
  expect(createsSent(diagnostics), report()).toBeGreaterThan(creates1);
  await expect(sheet).toHaveCount(0);
  await playAndReturn(page, request, enrollmentId, target.id);
  const early = await readTarget(page.request, target.id);
  expect(early.today, report()).toMatchObject({ state: 'done', sessions_budget: budget, sessions_done: 1, ended_early: false });
  // Phase 67b (spec D6): before the eve only the day's first answers count, and they are in.
  expect(early.practice_more_little, report()).toBe(true);
  await expectSessions(card, target.id, { ...MET_DONE, side: null, dots: ['done'] });
  await expectReadiness(card, early);
  await expectLabel(practice, 'לתרגל עוד');

  // 3. Today reads done, so "לתרגל עוד" asks (phase 65b D1), with no number; "אחזור מחר" closes the
  // sheet and starts nothing.
  let creates = createsSent(diagnostics);
  await tapCardUntil(page, target.id, 'practice-more-sheet');
  await expect(sheet).toContainText('עשית עבודה מצוינת להיום');
  await expect(sheet).toContainText('עוד תרגול היום לא יתרום הרבה');
  await expect(sheet).not.toContainText(/\d/);
  await expect(tick).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('practice-more-later').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('progress-label')).toBeHidden();
  expect(createsSent(diagnostics), report()).toBe(creates);
  // הגדרות, shown now, reads the asking on. Its tab stays mounted from here, so step 6 shows that
  // it reads the choice again each time it is shown (final review I3).
  await page.getByTestId('settings-tab').click();
  await expect(page.getByTestId('settings-practice-more-ask').getByRole('switch')).toBeChecked();
  await page.getByTestId('tab-home').click();
  await showCard(page, target.id);

  /** The side and dots once `more` sessions past the budget are done. */
  const past = (more: number) => ({
    ...MET_DONE,
    side: `+${more} בונוס`,
    dots: [...Array<string>(budget).fill('done'), ...Array<string>(more).fill('bonus')],
  });

  // 4. Asked again, "לתרגל בכל זאת" starts the session: a bonus past the budget.
  creates = createsSent(diagnostics);
  await tapCardUntil(page, target.id, 'practice-more-sheet');
  await page.getByTestId('practice-more-anyway').click();
  await expect(page.getByTestId('progress-label'), report()).toBeVisible();
  expect(createsSent(diagnostics), report()).toBeGreaterThan(creates);
  await playAndReturn(page, request, enrollmentId, target.id);
  const met = await readTarget(page.request, target.id);
  expect(met.today, report()).toMatchObject({ state: 'done', sessions_budget: budget, sessions_done: budget + 1, ended_early: false });
  await expectSessions(card, target.id, past(1));
  await expectReadiness(card, met);

  // 5. "אל תציג לי את זה שוב", then "אחזור מחר": nothing starts, and the next tap starts the
  // session at once, with no sheet: past the budget, a second bonus dot.
  await tapCardUntil(page, target.id, 'practice-more-sheet');
  await tick.click();
  await expect(tick).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('practice-more-later').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('progress-label')).toBeHidden();
  await tapCardUntil(page, target.id, 'progress-label');
  await expect(sheet).toHaveCount(0);
  await playAndReturn(page, request, enrollmentId, target.id);
  expect((await readTarget(page.request, target.id)).today).toMatchObject({ sessions_done: budget + 2 });
  await expectSessions(card, target.id, past(2));

  // 6. הגדרות, shown again, reads the asking turned off; turned back on, "לתרגל עוד" asks again.
  await page.getByTestId('settings-tab').click();
  const ask = page.getByTestId('settings-practice-more-ask').getByRole('switch');
  await expect(ask).not.toBeChecked();
  await ask.click();
  await expect(ask).toBeChecked();
  await page.getByTestId('tab-home').click();
  await showCard(page, target.id);
  await tapCardUntil(page, target.id, 'practice-more-sheet');
  await expect(tick).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('practice-more-later').click();
  await expect(sheet).toBeHidden();
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
