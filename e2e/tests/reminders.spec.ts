import { expect, test, type Page } from '@playwright/test';

import { openApp, signUpLearner } from './support/users';

test.setTimeout(120_000);

// Phase 52 (spec D8). The Reminders screen, opened from Profile: the defaults a
// learner who never opened it has, and the three changes that must survive a
// reload. The web build has no push, so the screen says so, and the schedule is
// still stored for the phone.

/** Home, then Profile, then Reminders: what a learner taps. */
async function openReminders(page: Page): Promise<void> {
  await page.getByTestId('profile-button').click();
  await page.getByTestId('profile-reminders').click();
  await expect(page.getByTestId('reminders-target')).toBeVisible();
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

  // Every day, 13:00, 17:00, 20:00 and 22:00, one session a day.
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
  await expect(page.getByTestId('reminders-target')).toHaveText('1');
  await expect(page.getByTestId('reminders-enabled')).toBeVisible();
  // The web has no push: the schedule is kept for the phone, and the screen says so.
  await expect(page.getByTestId('reminders-unsupported')).toBeVisible();
  await expect(page.getByTestId('reminders-enable')).toHaveCount(0);
  await expect(page.getByTestId('reminders-denied')).toHaveCount(0);

  // Sunday off, 09:00 on, two sessions a day.
  await saves(page, 'reminders-day-7');
  await chip(page, 'reminders-day-7').toHaveAttribute('aria-selected', 'false');
  await saves(page, 'reminders-hour-09');
  await chip(page, 'reminders-hour-09').toHaveAttribute('aria-selected', 'true');
  await saves(page, 'reminders-target-plus');
  await expect(page.getByTestId('reminders-target')).toHaveText('2');

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
  await expect(page.getByTestId('reminders-target')).toHaveText('2');
});
