import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { expectGeneration } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { enrollmentIdOf, readyPathSession, skipSeed } from './support/sessions';
import {
  DONE_TODAY,
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

// Phase 65 (spec D7, D9). Practising past the day's budget. A homework of one word, on a device
// with no voice and no microphone, so its readiness counts writing and spelling: its sessions are
// played through the card's button until the budget is met, each entered at once, and past it
// while a counted skill still has a bonus left today; then another session could add only a little
// (every counted skill has had its first answer and both of the day's bonuses), and "לתרגל עוד"
// asks first. "אחזור מחר" closes the sheet, "לתרגל בכל זאת" starts the session, the tick box stops
// the asking, and the switch in הגדרות, which reads the choice each time it is shown, brings it
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
  await page.getByTestId('results-next-session').click();
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
  // session's start sets: the word's ladder does the day's work in one session (its practice cards
  // take its skills to the far cap, ruling T9-a), and the default miss rate keeps one more for
  // misses, ceil(1 / 0.8) = 2. So the loop below meets the budget after ending early once.
  const offered = await readTarget(page.request, target.id);
  expect(offered.today, report()).toMatchObject({ state: 'owed', sessions_budget: null, sessions_done: 0 });
  const budget = offered.today.sessions_offer;
  expect(budget, report()).toBe(2);
  await expectSessions(card, target.id, offerOf(offered.today));

  // 2. The budget's sessions, each straight in from the card: until the last, another session
  // still adds more than a little, so nothing asks. The first does the day's work (the word's
  // ladder, every answer right), so the day reads done from then on: in place of the budget
  // until it is met, its unused dots faded (spec D5, D7.6).
  for (let done = 1; done <= budget; done++) {
    const before = await readTarget(page.request, target.id);
    expect(before.practice_more_little, `before session ${done}: ${JSON.stringify(before.today)}`).toBe(false);
    const creates = createsSent(diagnostics);
    await tapCardUntil(page, target.id, 'progress-label');
    expect(createsSent(diagnostics), report()).toBeGreaterThan(creates);
    await expect(sheet).toHaveCount(0);
    await playAndReturn(page, request, enrollmentId, target.id);
    const after = await readTarget(page.request, target.id);
    expect(after.today, report()).toMatchObject({ state: 'done', sessions_budget: budget, sessions_done: done, ended_early: done < budget });
    await expectSessions(card, target.id, {
      line: DONE_TODAY,
      side: done < budget ? `${done} במקום ${budget}` : null,
      dots: [...Array<string>(done).fill('done'), ...Array<string>(budget - done).fill('faded')],
    });
    await expectReadiness(card, after);
    await expectLabel(practice, 'לתרגל עוד');
  }

  // 3. The budget met, a session still goes straight in while one more could add more than a
  // little: a counted skill has a bonus left today, which practice_more_little counts (spec D9, the
  // most every right answer still countable today could add). Each is a bonus dot past the budget.
  // A skill has at most READINESS_BONUS_PER_DAY (2) bonuses a day, so at most two such sessions.
  let extra = 0;
  while (!(await readTarget(page.request, target.id)).practice_more_little) {
    extra += 1;
    expect(extra, `sessions past the budget before the sheet: ${report()}`).toBeLessThanOrEqual(2);
    const creates = createsSent(diagnostics);
    await tapCardUntil(page, target.id, 'progress-label');
    expect(createsSent(diagnostics), report()).toBeGreaterThan(creates);
    await expect(sheet).toHaveCount(0);
    await playAndReturn(page, request, enrollmentId, target.id);
    const after = await readTarget(page.request, target.id);
    expect(after.today, report()).toMatchObject({ state: 'done', sessions_budget: budget, sessions_done: budget + extra, ended_early: false });
    await expectSessions(card, target.id, {
      line: DONE_TODAY,
      side: `+${extra} בונוס`,
      dots: [...Array<string>(budget).fill('done'), ...Array<string>(extra).fill('bonus')],
    });
  }
  /** The side and dots once `more` sessions past the budget are done. */
  const past = (more: number) => ({
    line: DONE_TODAY,
    side: `+${more} בונוס`,
    dots: [...Array<string>(budget).fill('done'), ...Array<string>(more).fill('bonus')],
  });

  // 4. Now one more session could add only a little (spec D9). "לתרגל עוד" asks, with no number;
  // "אחזור מחר" closes the sheet and starts nothing.
  const met = await readTarget(page.request, target.id);
  expect(met.practice_more_little, JSON.stringify(met.words)).toBe(true);
  let creates = createsSent(diagnostics);
  await tapCardUntil(page, target.id, 'practice-more-sheet');
  await expect(sheet).toContainText('סיימת את התרגול של היום');
  await expect(sheet).toContainText('עוד תרגול היום יעלה את המוכנות רק מעט');
  await expect(sheet).not.toContainText(/\d/);
  await expect(tick).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('practice-more-later').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('progress-label')).toBeHidden();
  expect(createsSent(diagnostics), report()).toBe(creates);
  // הגדרות, shown now, reads the asking on. Its tab stays mounted from here, so step 7 shows that
  // it reads the choice again each time it is shown (final review I3).
  await page.getByTestId('settings-tab').click();
  await expect(page.getByTestId('settings-practice-more-ask').getByRole('switch')).toBeChecked();
  await page.getByTestId('tab-home').click();
  await showCard(page, target.id);

  // 5. Asked again, "לתרגל בכל זאת" starts the session. Past the budget it is a bonus dot, and
  // readiness moves by less than the sheet's little.
  creates = createsSent(diagnostics);
  await tapCardUntil(page, target.id, 'practice-more-sheet');
  await page.getByTestId('practice-more-anyway').click();
  await expect(page.getByTestId('progress-label'), report()).toBeVisible();
  expect(createsSent(diagnostics), report()).toBeGreaterThan(creates);
  await playAndReturn(page, request, enrollmentId, target.id);
  const bonus = await readTarget(page.request, target.id);
  expect(bonus.today, report()).toMatchObject({ state: 'done', sessions_budget: budget, sessions_done: budget + extra + 1, ended_early: false });
  expect(bonus.readiness_pct - met.readiness_pct).toBeLessThan(2);
  await expectSessions(card, target.id, past(extra + 1));
  await expectReadiness(card, bonus);

  // 6. "אל תציג לי את זה שוב", then "אחזור מחר": nothing starts, and the next tap starts the
  // session at once, with no sheet.
  await tapCardUntil(page, target.id, 'practice-more-sheet');
  await tick.click();
  await expect(tick).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('practice-more-later').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('progress-label')).toBeHidden();
  await tapCardUntil(page, target.id, 'progress-label');
  await expect(sheet).toHaveCount(0);
  await playAndReturn(page, request, enrollmentId, target.id);
  expect((await readTarget(page.request, target.id)).today).toMatchObject({ sessions_done: budget + extra + 2 });
  await expectSessions(card, target.id, past(extra + 2));

  // 7. הגדרות, shown again, reads the asking turned off; turned back on, "לתרגל עוד" asks again.
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
