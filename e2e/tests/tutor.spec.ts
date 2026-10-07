import { expect, test, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { lookUp, tapAndWaitForWrite } from './support/interactions';
import { LUK } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { createLearner, createUser, logIn } from './support/users';

test.setTimeout(180_000);

const TUTOR = 'e2e_tutor_rina';
const STUDENT = 'e2e_tutor_student';

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

/** Waits for a grant call to answer before anything reloads. */
async function tapAndWaitForGrant(page: Page, testId: string, method: 'POST' | 'DELETE') {
  const answered = page.waitForResponse(
    (res) => /\/api\/grants/.test(res.url()) && res.request().method() === method,
  );
  await page.getByTestId(testId).click();
  expect((await answered).ok()).toBe(true);
}

test('a tutor invites a student, adds a word to their list, and the student ends it', async ({ page, request }) => {
  await createUser(request, TUTOR, 'רינה');
  await createLearner(request, STUDENT, 'ru');

  // 1. A tutor who learns nothing is offered to teach, and invites the student.
  await logIn(page, TUTOR, 'enroll-teach');
  await page.getByTestId('enroll-teach').click();
  await page.getByTestId('invite-username').fill(STUDENT);
  await page.getByTestId('invite-language-ru').click();
  await tapAndWaitForGrant(page, 'invite-submit', 'POST');
  await expect(page.getByTestId(`student-${STUDENT}`)).toBeVisible();

  // 2. The student sees the invite on home and accepts it.
  await logIn(page, STUDENT);
  await expect(page.getByTestId('invite-card')).toContainText('רינה');
  await tapAndWaitForGrant(page, 'invite-accept', 'POST');
  await expect(page.getByTestId('invite-card')).toHaveCount(0);

  // 3. The tutor opens the student and adds a word.
  await logIn(page, TUTOR, `student-${STUDENT}`);
  await page.getByTestId(`student-${STUDENT}`).click();
  await expect(page.getByTestId('student-words-title')).toBeVisible();
  await lookUp(page, request, 'лук', LUK);
  const add = page.getByTestId('translate-save').first();
  await tapAndWaitForWrite(page, add);
  await expect(add).toHaveText('נוסף ✓');

  // 4. The student's saved list says who added it.
  await logIn(page, STUDENT);
  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-added-by').first()).toHaveText('נוספה ע״י רינה');

  // 5. The student ends the link; the tutor no longer has them.
  await logIn(page, STUDENT);
  await page.getByTestId('profile-button').click();
  await expect(page.getByTestId(`tutor-${TUTOR}`)).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await tapAndWaitForGrant(page, `tutor-end-${TUTOR}`, 'DELETE');
  await expect(page.getByTestId(`tutor-${TUTOR}`)).toHaveCount(0);

  // The landing is the proof: login loads grants before home decides the
  // redirect (needsEnrollScreen), so a tutor who still held the grant would
  // land on home and logIn would time out waiting for enroll-teach.
  await logIn(page, TUTOR, 'enroll-teach');
  await expect(page.getByTestId('students-section')).toHaveCount(0);
  await expect(page.getByTestId(`student-${STUDENT}`)).toHaveCount(0);
});

test("a tutor stops tutoring a student from the student's screen", async ({ page, request }) => {
  const tutorName = 'e2e_tutor_stopper';
  const studentName = 'e2e_tutor_stopped';
  const tutor = await createUser(request, tutorName, 'שרה');
  const learner = await createLearner(request, studentName, 'ru');

  const invited = await request.post(`${API_URL}/api/grants`, {
    headers: { 'X-Acting-User-Id': tutor.id },
    data: { username: studentName, target_language: 'ru' },
  });
  expect(invited.ok()).toBe(true);
  const grant = (await invited.json()) as { id: string };
  const accepted = await request.post(`${API_URL}/api/grants/${grant.id}/accept`, {
    headers: { 'X-Acting-User-Id': learner.id },
  });
  expect(accepted.ok()).toBe(true);

  await logIn(page, tutorName, `student-${studentName}`);
  await page.getByTestId(`student-${studentName}`).click();
  await expect(page.getByTestId('student-words-title')).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await tapAndWaitForGrant(page, 'student-stop', 'DELETE');

  // A tutor with no grants and no enrollments is sent to choose a language.
  await expect(page.getByTestId('enroll-teach')).toBeVisible();
  await expect(page.getByTestId(`student-${studentName}`)).toHaveCount(0);
});
