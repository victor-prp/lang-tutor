import { expect, test, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { lookUp, tapAndWaitForWrite } from './support/interactions';
import { LUK } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { openApp, signUpLearner, signUpUser } from './support/users';

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

test('a tutor invites a student, adds a word to their list, and the student ends it', async ({ page, request, browser }) => {
  // Two people, two browser contexts: the student in `page`, the tutor in a second one.
  const tutorContext = await browser.newContext();
  const tutorPage = await tutorContext.newPage();
  await signUpUser(tutorPage.request, TUTOR, 'רינה');
  await signUpLearner(page, STUDENT, 'ru');

  // 1. A tutor who learns nothing is offered to teach, and invites the student.
  await openApp(tutorPage, 'enroll-teach');
  await tutorPage.getByTestId('enroll-teach').click();
  await tutorPage.getByTestId('invite-username').fill(STUDENT);
  await tutorPage.getByTestId('invite-language-ru').click();
  await tapAndWaitForGrant(tutorPage, 'invite-submit', 'POST');
  await expect(tutorPage.getByTestId(`student-${STUDENT}`)).toBeVisible();

  // 2. The student sees the invite on home and accepts it.
  await openApp(page);
  await expect(page.getByTestId('invite-card')).toContainText('רינה');
  await tapAndWaitForGrant(page, 'invite-accept', 'POST');
  await expect(page.getByTestId('invite-card')).toHaveCount(0);

  // 3. The tutor opens the student and adds a word.
  await openApp(tutorPage, `student-${STUDENT}`);
  await tutorPage.getByTestId(`student-${STUDENT}`).click();
  await expect(tutorPage.getByTestId('student-words-title')).toBeVisible();
  await lookUp(tutorPage, request, 'лук', LUK);
  const add = tutorPage.getByTestId('translate-save').first();
  await tapAndWaitForWrite(tutorPage, add);
  await expect(add).toHaveText('נוסף ✓');

  // 4. The student's saved list says who added it.
  await openApp(page);
  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-added-by').first()).toHaveText('נוספה ע״י רינה');

  // 5. The student ends the link; the tutor no longer has them.
  await openApp(page);
  await page.getByTestId('profile-button').click();
  await expect(page.getByTestId(`tutor-${TUTOR}`)).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await tapAndWaitForGrant(page, `tutor-end-${TUTOR}`, 'DELETE');
  await expect(page.getByTestId(`tutor-${TUTOR}`)).toHaveCount(0);

  // The landing is the proof: login loads grants before home decides the
  // redirect (needsEnrollScreen), so a tutor who still held the grant would
  // land on home and openApp would time out waiting for enroll-teach.
  await openApp(tutorPage, 'enroll-teach');
  await expect(tutorPage.getByTestId('students-section')).toHaveCount(0);
  await expect(tutorPage.getByTestId(`student-${STUDENT}`)).toHaveCount(0);
  await tutorContext.close();
});

test("a tutor stops tutoring a student from the student's screen", async ({ page, browser }) => {
  const tutorName = 'e2e_tutor_stopper';
  const studentName = 'e2e_tutor_stopped';
  const tutorContext = await browser.newContext();
  const tutorPage = await tutorContext.newPage();
  await signUpUser(tutorPage.request, tutorName, 'שרה');
  await signUpLearner(page, studentName, 'ru');

  const invited = await tutorPage.request.post(`${API_URL}/api/grants`, {
    data: { username: studentName, target_language: 'ru' },
  });
  expect(invited.ok()).toBe(true);
  const grant = (await invited.json()) as { id: string };
  const accepted = await page.request.post(`${API_URL}/api/grants/${grant.id}/accept`);
  expect(accepted.ok()).toBe(true);

  await openApp(tutorPage, `student-${studentName}`);
  await tutorPage.getByTestId(`student-${studentName}`).click();
  await expect(tutorPage.getByTestId('student-words-title')).toBeVisible();

  tutorPage.once('dialog', (dialog) => void dialog.accept());
  await tapAndWaitForGrant(tutorPage, 'student-stop', 'DELETE');

  // A tutor with no grants and no enrollments is sent to choose a language.
  await expect(tutorPage.getByTestId('enroll-teach')).toBeVisible();
  await expect(tutorPage.getByTestId(`student-${studentName}`)).toHaveCount(0);
  await tutorContext.close();
});
