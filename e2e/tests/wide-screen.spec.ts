import { expect, test } from '@playwright/test';

import { openApp, signUpLearner } from './support/users';

// Phase 36 (spec D8). On a screen wider than a phone, every screen sits in one
// centred column at most 640 wide instead of stretching edge to edge. The
// viewport is a 13-inch iPad's in portrait: the automated stand-in for the
// iPad simulator check, which needs Xcode.
test.use({ viewport: { width: 1024, height: 1366 } });

test('on an iPad-wide screen, home sits in a centred column at most 640 wide', async ({ page }) => {
  await signUpLearner(page, 'e2e_wide_screen', 'it');
  await openApp(page);

  const column = await page.getByTestId('content-column').boundingBox();
  const start = await page.getByTestId('start-button').boundingBox();
  if (!column || !start) throw new Error('the content column or the start button has no box');

  expect(column.width).toBeLessThanOrEqual(640);
  expect(Math.abs(column.x + column.width / 2 - 1024 / 2)).toBeLessThanOrEqual(2);
  expect(start.x).toBeGreaterThanOrEqual(column.x);
  expect(start.x + start.width).toBeLessThanOrEqual(column.x + column.width);
});
