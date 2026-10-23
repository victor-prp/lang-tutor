import { expect, test, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { clearGemini } from './support/mockServer';
import { answerSessionRight, readCurrent, readyPathSession, skipSeed } from './support/sessions';
import { MY_WORDS, firstForm, formsOf, homework, readTarget } from './support/targets';
import { openApp, signUpLearner } from './support/users';

test.setTimeout(120_000);

// Phase 52 (spec D8). The Reminders screen, opened from Profile: the defaults a
// learner who never opened it has, and the three changes that must survive a
// reload. The web build has no push, so the screen says so, and the schedule is
// still stored for the phone.

/** הגדרות, then Reminders: what a learner taps (phase 64, spec D7). */
async function openReminders(page: Page): Promise<void> {
  await page.getByTestId('settings-tab').click();
  await page.getByTestId('profile-reminders').click();
  await expect(page.getByTestId('reminders-enabled')).toBeVisible();
}

/** A tap that saves: the click, and the PUT it sends having answered. */
async function saves(page: Page, testID: string): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/me/reminders') && response.request().method() === 'PUT' && response.ok(),
    ),
    page.getByTestId(testID).click(),
  ]);
}

const chip = (page: Page, testID: string) => expect(page.getByTestId(testID));

test('the reminder schedule starts at the defaults and keeps a change across a reload', async ({ page }) => {
  await signUpLearner(page, 'e2e_reminders');
  await openApp(page);
  await openReminders(page);

  // Every day, 13:00, 17:00, 20:00 and 22:00. Phase 75 (spec D7): no daily count of sessions;
  // reminders follow each path's own day.
  for (let day = 1; day <= 7; day += 1) {
    await chip(page, `reminders-day-${day}`).toHaveAttribute('aria-selected', 'true');
  }
  for (let hour = 6; hour <= 23; hour += 1) {
    const id = String(hour).padStart(2, '0');
    await chip(page, `reminders-hour-${id}`).toHaveAttribute(
      'aria-selected',
      [13, 17, 20, 22].includes(hour) ? 'true' : 'false',
    );
  }
  await expect(page.getByTestId('reminders-target')).toHaveCount(0);
  await expect(page.getByTestId('reminders-target-plus')).toHaveCount(0);
  await expect(page.getByTestId('reminders-enabled')).toBeVisible();
  // The web has no push: the schedule is kept for the phone, and the screen says so.
  await expect(page.getByTestId('reminders-unsupported')).toBeVisible();
  await expect(page.getByTestId('reminders-enable')).toHaveCount(0);
  await expect(page.getByTestId('reminders-denied')).toHaveCount(0);

  // Sunday off, 09:00 on. The stored daily_target, which old apps still show, is sent back as read.
  await saves(page, 'reminders-day-7');
  await chip(page, 'reminders-day-7').toHaveAttribute('aria-selected', 'false');
  await saves(page, 'reminders-hour-09');
  await chip(page, 'reminders-hour-09').toHaveAttribute('aria-selected', 'true');
  const stored = await page.request.get(`${API_URL}/api/me/reminders`);
  expect(await stored.json()).toMatchObject({ daily_target: 1, days: [1, 2, 3, 4, 5, 6] });

  // A reload: the app opens again from the server, signed in. It goes back to the
  // root, not to /reminders: the source target's `expo serve` has no fallback to
  // index.html for a deep link (see deep-link.spec.ts).
  await openApp(page);
  await openReminders(page);
  await chip(page, 'reminders-day-7').toHaveAttribute('aria-selected', 'false');
  for (let day = 1; day <= 6; day += 1) {
    await chip(page, `reminders-day-${day}`).toHaveAttribute('aria-selected', 'true');
  }
  for (const hour of ['09', '13', '17', '20', '22']) {
    await chip(page, `reminders-hour-${hour}`).toHaveAttribute('aria-selected', 'true');
  }
  await chip(page, 'reminders-hour-06').toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('reminders-target')).toHaveCount(0);
});

// Phase 57 (spec D2, D11). A tapped reminder opens home with start=reminder, and home starts
// the path of its first card: a target while it owes work today, My words once it is done.
// The web build has no push, so the spec opens that link itself.
test('a reminder opens the path of home’s first card: the homework owing work, then My words', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await clearGemini(request);
  const { enrollmentId, target } = await homework(page, request, 'e2e_reminders_paths');
  // Both paths have a session ready, so the reminder has a choice to make.
  const targetSession = await readyPathSession(page.request, enrollmentId, target.id);
  const mainSession = await readyPathSession(page.request, enrollmentId);

  /** The reminder's link, opened, and the session it entered: the word it asks first. */
  const remind = async () => {
    await page.goto('/?start=reminder');
    await expect(page.getByTestId('progress-label'), report()).toBeVisible({ timeout: 30_000 });
    return firstForm(page);
  };

  // The homework owes work: its card is first, and the reminder enters its session, through
  // create (final review C1), judged on the targets read made after the tap (CI-1).
  const creates = () => diagnostics.apiRequests.filter((sent) => /^POST \S+\/api\/sessions$/.test(sent)).length;
  expect(formsOf(target, 'owed'), report()).toContain(await remind());
  expect((await readCurrent(page.request, enrollmentId, target.id)).current?.session_id).toBe(targetSession);
  expect(creates(), report()).toBe(1);

  // Done for today (that session answered over the API): My words is first, and opened.
  await answerSessionRight(page.request, targetSession);
  expect((await readTarget(page.request, target.id)).today.state).toBe('done');
  expect(MY_WORDS.map((word) => word.form), report()).toContain(await remind());
  expect((await readCurrent(page.request, enrollmentId)).current?.session_id).toBe(mainSession);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

// Phase 75 (spec D6). A reminder that names its path opens that path's session, whichever card is
// first on home: the link home receives carries the path, and home opens the practice screen,
// which goes straight into the session. A path that is gone leaves the learner on home.
test('a reminder that names its path opens that path’s session, not the first card’s', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await clearGemini(request);
  const { enrollmentId, target } = await homework(page, request, 'e2e_reminders_named');
  const targetSession = await readyPathSession(page.request, enrollmentId, target.id);
  const mainSession = await readyPathSession(page.request, enrollmentId);

  const remind = async (query: string) => {
    await page.goto(`/?start=reminder&${query}`);
    await expect(page.getByTestId('progress-label'), report()).toBeVisible({ timeout: 30_000 });
    return firstForm(page);
  };

  // The homework owes work and its card is first; the reminder names My words, and My words opens.
  expect(MY_WORDS.map((word) => word.form), report()).toContain(await remind(`enrollment=${enrollmentId}`));
  expect((await readCurrent(page.request, enrollmentId)).current?.session_id, report()).toBe(mainSession);

  // The reminder names the homework: its session opens, through create, as its card's button does.
  expect(formsOf(target, 'owed'), report()).toContain(await remind(`enrollment=${enrollmentId}&target=${target.id}`));
  expect((await readCurrent(page.request, enrollmentId, target.id)).current?.session_id, report()).toBe(targetSession);

  // A target that is gone (here, one that never was): home, and no session.
  await page.goto(`/?start=reminder&enrollment=${enrollmentId}&target=00000000-0000-4000-8000-000000000000`);
  await expect(page.getByTestId(`target-card-${target.id}`), report()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('progress-label')).toBeHidden();
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

// Phase 75 (spec D6, plan review focus 4). A reminder about the course that is not the active one
// switches to it first: Italian, with no word of its own, opens its Words for me, never Russian's.
test('a reminder about the other course switches to it before opening its path', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await clearGemini(request);
  const { enrollmentId: russian, target } = await homework(page, request, 'e2e_reminders_course');
  const enrolled = await page.request.post(`${API_URL}/api/enrollments`, { data: { source_language: 'he', target_language: 'it' } });
  expect(enrolled.ok(), await enrolled.text()).toBe(true);
  const italian = ((await enrolled.json()) as { id: string }).id;
  await skipSeed(page.request, italian);
  // Russian active, as the learner leaves it with the switcher, which the app remembers.
  await page.goto('/');
  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-option-ru').click();
  await expect(page.getByTestId(`target-card-${target.id}`)).toBeVisible({ timeout: 30_000 });

  await page.goto(`/?start=reminder&enrollment=${italian}`);
  await expect(page.getByTestId('discover-question'), report()).toHaveText('כמה איטלקית אתם כבר יודעים?', { timeout: 30_000 });
  expect((await readCurrent(page.request, russian)).current?.started ?? false, report()).toBe(false);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
