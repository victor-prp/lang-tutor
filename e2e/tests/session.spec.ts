import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { stripIsolates } from './support/text';

const SESSION_LENGTH = 10;
const CHOSEN_OPTION = 0;

// Ten server round trips plus a build-free page load; comfortably inside this,
// but well above the 30s default.
test.setTimeout(120_000);

test('a full session scores exactly the answers given', async ({ page }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);

  await page.goto('/');
  await expect(page.getByTestId('start-button'), `home never rendered\n${report()}`).toBeVisible();
  // web.output: "static" pre-renders start-button in the raw HTML before React
  // hydrates. page.goto only waits for `load`, not hydration, so a click that
  // lands in that window is a silent no-op. Retry the click until the session
  // screen actually mounts. Later clicks in the loop below follow a real server
  // round trip, so hydration is long complete by then and need no such retry.
  await expect(async () => {
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('progress-label')).toBeVisible({ timeout: 2_000 });
  }, `never reached the session screen after clicking start\n${report()}`).toPass({ timeout: 30_000 });

  let expectedCorrect = 0;
  const prompts: string[] = [];

  for (let position = 1; position <= SESSION_LENGTH; position++) {
    // Waiting on the counter, not on an option being visible: the previous
    // question's options stay mounted while the banner is up, so "an option is
    // visible" is continuously true and would let the loop click the same
    // question twice. The counter changes exactly once per advance.
    await expect(
      page.getByTestId('progress-label'),
      `never reached question ${position}\n${report()}`,
    ).toHaveText(new RegExp(`${position}\\s*/\\s*${SESSION_LENGTH}`));

    prompts.push(stripIsolates(await page.getByTestId('question-prompt').textContent()));

    await page.getByTestId(`option-${CHOSEN_OPTION}`).click();

    // Exactly one of these two mounts, and which one tells us whether the
    // fixed choice happened to be right.
    const correctBanner = page.getByTestId('feedback-correct');
    const wrongBanner = page.getByTestId('feedback-wrong');
    await expect(
      correctBanner.or(wrongBanner),
      `no feedback after answering question ${position}\n${report()}`,
    ).toBeVisible();

    if (await correctBanner.isVisible()) expectedCorrect++;

    await page.getByTestId('continue-button').click();
  }

  // 1. The server's score.correct against ten independent UI observations.
  await expect(
    page.getByTestId('results-score'),
    `results screen never rendered\n${report()}`,
  ).toBeVisible();
  expect(
    stripIsolates(await page.getByTestId('results-score').textContent()),
    `score disagreed with the ${expectedCorrect} correct answer(s) observed\n${report()}`,
  ).toBe(`${expectedCorrect} / ${SESSION_LENGTH}`);

  // 2. missed_questions comes from a different core function (missed, not
  //    score) over the same answers, so this catches a bug in one that the
  //    other would hide.
  await expect(page.getByTestId('missed-row')).toHaveCount(SESSION_LENGTH - expectedCorrect);

  // 3. The counter cannot detect a re-served question: an idempotency bug that
  //    replayed one would still advance it. Distinct prompts can.
  expect(new Set(prompts).size, `a question was served twice: ${prompts.join(', ')}`).toBe(
    SESSION_LENGTH,
  );

  expect(diagnostics.failedRequests, report()).toEqual([]);
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
