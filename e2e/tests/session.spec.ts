import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';

test('loads the app and serves a first question from the real server', async ({ page }) => {
  const diagnostics = attachDiagnostics(page, API_URL);

  await page.goto('/');
  await expect(page.getByTestId('start-button')).toBeVisible();

  await page.getByTestId('start-button').click();

  // The session screen renders nothing until the server's first question
  // arrives, so these three passing means the whole pipeline works:
  // export -> serve -> browser -> Hono -> browser -> render.
  await expect(
    page.getByTestId('progress-label'),
    `progress label never appeared\n${diagnosticReport(diagnostics)}`,
  ).toBeVisible();
  await expect(page.getByTestId('question-prompt')).toBeVisible();
  await expect(page.getByTestId('option-0')).toBeVisible();

  expect(
    diagnostics.apiRequests.length,
    `expected a session-creation request\n${diagnosticReport(diagnostics)}`,
  ).toBeGreaterThan(0);
  expect(diagnostics.failedRequests, diagnosticReport(diagnostics)).toEqual([]);
});
