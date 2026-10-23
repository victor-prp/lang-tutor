import { expect, test, type Page } from '@playwright/test';

import { expectGeneration } from './support/cards';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { enrollmentIdOf, makeSeed } from './support/sessions';
import { addDays, createTarget, lookUpEntries, readTargets, saveEntries } from './support/targets';
import { openApp, signUpLearner } from './support/users';

// Phase 64 (spec D1, D2, D10). The bar's four tabs reach each other without home; the header's
// translate opens over the tab it was pressed on and returns to it; the bar is not there in a
// session; and the language switched from the header on מילים switches the list too.
test.setTimeout(150_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

async function startSession(page: Page) {
  await expect(async () => {
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('progress-label')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('the four tabs reach each other, translate returns to its tab, and a session has no bar', async ({ page }) => {
  await signUpLearner(page, 'e2e_tabs_walk', 'ru');
  // A session to open at the end: the seed, made over the API, since the card never starts it
  // (phase 73, spec D6).
  await makeSeed(page.request, await enrollmentIdOf(page.request));
  await openApp(page);

  // Each tab from the one before, never through home.
  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-title')).toHaveText('המילים שלי');
  await page.getByTestId('profile-button').click();
  await expect(page.getByTestId('profile-username')).toHaveText('e2e_tabs_walk');
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
  await page.getByTestId('settings-tab').click();
  await expect(page.getByTestId('app-version')).toBeVisible();
  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-title')).toBeVisible();
  await expect(page.getByTestId('vocabulary-entry')).toHaveAttribute('aria-selected', 'true');

  // Translate opens over מילים, with no bar, and its ✕ returns to מילים.
  await page.getByTestId('translate-entry').click();
  await expect(page.getByTestId('translate-input')).toBeVisible();
  await expect(page.getByTestId('settings-tab')).toBeHidden();
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('vocabulary-title')).toBeVisible();
  await expect(page.getByTestId('vocabulary-entry')).toHaveAttribute('aria-selected', 'true');

  // A session covers the bar (Victor: "we want the learner to be focused").
  await page.getByTestId('tab-home').click();
  await startSession(page);
  await expect(page.getByTestId('settings-tab')).toBeHidden();
  await page.getByTestId('session-back').click();
  await expect(page.getByTestId('settings-tab')).toBeVisible();
});

test('the language switched from the header on מילים switches the list with it', async ({ page, request }) => {
  await signUpLearner(page, 'e2e_tabs_switch', 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  const [daisy] = await lookUpEntries(page.request, enrollmentId, BOARD_WORDS.slice(0, 1));
  await expectGeneration(request);
  await saveEntries(page.request, enrollmentId, daisy);
  await openApp(page, 'enrollment-switcher');

  // A second language, English, with nothing saved yet.
  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-add').click();
  await page.getByTestId('enroll-en').click();
  await page.getByTestId('enroll-submit').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('אנגלית ▾');

  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-empty')).toBeVisible();
  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-option-ru').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('רוסית ▾');
  await expect(page.getByTestId('vocabulary-word')).toHaveCount(1);
  await expect(page.getByTestId('vocabulary-word')).toContainText(BOARD_WORDS[0].form);
});

// Phase 64b (spec D1, D2, D4). The first tab is בית. Under the cards, a named bar per card:
// tapping one brings its card, and every card is as tall as the others.
test('the first tab is בית, named bars bring their cards, and the cards are one height', async ({ page, request }) => {
  // A repeat's index keeps the name new under --repeat-each (none on a single run).
  await signUpLearner(page, `e2e_tabs_bars${test.info().repeatEachIndex || ''}`, 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  const [mine, examWord] = await lookUpEntries(page.request, enrollmentId, BOARD_WORDS.slice(0, 2));
  await expectGeneration(request);
  await saveEntries(page.request, enrollmentId, mine);
  const { today } = await readTargets(page.request, enrollmentId);
  const exam = await createTarget(page.request, enrollmentId, { kind: 'exam', due_on: addDays(today, 5), entries: examWord });
  await openApp(page, `home-bar-${exam.id}`);

  await expect(page.getByTestId('tab-home')).toContainText('בית');
  await expect(page.getByTestId(`home-bar-${exam.id}`)).toHaveText('בוחן');
  await expect(page.getByTestId('home-bar-main')).toHaveText('המילים שלי');
  await expect(page.getByTestId('home-bar-main')).toHaveAttribute('aria-label', 'המילים שלי, 2 מתוך 2');

  const examCard = page.getByTestId(`target-card-${exam.id}`);
  const examBox = await examCard.boundingBox();
  await page.getByTestId('home-bar-main').click();
  await expect(page.getByTestId('home-bar-main')).toHaveAttribute('aria-selected', 'true');
  const mineCard = page.getByTestId('home-my-words');
  await expect(mineCard).toBeInViewport();
  const mineBox = await mineCard.boundingBox();
  expect(Math.round(mineBox?.height ?? 0)).toBe(Math.round(examBox?.height ?? -1));

  // A drag across a card slides to its neighbour (right brings the next, left goes back) and
  // never presses the card it starts on.
  await page.getByTestId(`home-bar-${exam.id}`).click();
  // The bar slides the row back to the exam: read the card's place only once the row is at rest,
  // or a slow runner measures it mid-slide and starts the drag outside the stack (CI, PR #211).
  await expect
    .poll(() => page.getByTestId('home-row').evaluate((row) => new DOMMatrix(getComputedStyle(row).transform).m41))
    .toBe(0);
  const drag = async (by: number) => {
    const box = await page.getByTestId(`target-card-${exam.id}`).boundingBox();
    if (!box) throw new Error('no exam card');
    // From the card's middle, on its header: the part a tap opens the target from.
    const y = box.y + 120;
    const x = box.x + box.width / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + by, y, { steps: 12 });
    await page.mouse.up();
  };
  await drag(180);
  await expect(page.getByTestId('home-bar-main')).toHaveAttribute('aria-selected', 'true');
  // A press would open the target's screen a moment after the release: give it that moment.
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('target-title')).toHaveCount(0);
  await expect(page.getByTestId('home-bar-main')).toBeVisible();
});

// Phase 64b final review. Only the card on show is there for a screen reader or a keyboard: the
// others are beside it, clipped, and must not be read or pressed; and coming back to בית snaps to
// the first card instead of sliding across every card back to it.
test('only the card on show is read, and coming back to בית snaps to the first card', async ({ page, request }) => {
  await signUpLearner(page, 'e2e_tabs_hidden', 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  const [mine, examWord] = await lookUpEntries(page.request, enrollmentId, BOARD_WORDS.slice(0, 2));
  await expectGeneration(request);
  await saveEntries(page.request, enrollmentId, mine);
  const { today } = await readTargets(page.request, enrollmentId);
  const exam = await createTarget(page.request, enrollmentId, { kind: 'exam', due_on: addDays(today, 5), entries: examWord });
  await openApp(page, `home-bar-${exam.id}`);
  await expect(page.getByTestId('start-button')).toHaveCount(1);

  // Two cards each with a button: only the one on show is in the accessibility tree.
  await expect(page.getByRole('button', { name: 'לתרגל עכשיו' })).toHaveCount(1);
  await page.getByTestId('home-bar-main').click();
  await expect(page.getByRole('button', { name: 'לתרגל עכשיו' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'לתרגל עכשיו' })).toHaveAttribute('data-testid', 'start-button');

  // Away and back: the row is at the first card at once, never somewhere in between.
  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-title')).toBeVisible();
  const step = await page.getByTestId('home-row').evaluate((row) => new DOMMatrix(getComputedStyle(row).transform).m41);
  expect(step).toBeGreaterThan(0);
  await page.evaluate(() => {
    const row = document.querySelector('[data-testid="home-row"]');
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    const sample = () => {
      if (row) seen.push(new DOMMatrix(getComputedStyle(row).transform).m41);
      if (seen.length < 60) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByTestId('tab-home').click();
  await page.waitForTimeout(1_200);
  const seen = await page.evaluate(() => (window as unknown as { seen: number[] }).seen);
  const between = seen.filter((x) => x > 1 && x < step - 1);
  expect(between, `the row passed through ${JSON.stringify(seen)}`).toEqual([]);
  expect(seen[seen.length - 1]).toBe(0);
});
