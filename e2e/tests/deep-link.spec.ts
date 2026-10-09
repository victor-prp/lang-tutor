import { expect, test } from '@playwright/test';

// Phase 30 (spec D15). In production one process serves the web export, and a
// reload on any screen asks the server for that screen's path. Only the image
// target has that server. `expo serve`, which the source target uses, has no
// fallback to index.html, and no other spec opens a path other than '/'.
test.skip(process.env.E2E_TARGET !== 'image', 'needs the image target: npm run e2e:image');

test('a reload on a deep link gets the app, not a 404', async ({ page }) => {
  const response = await page.goto('/session');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.locator('#root')).toBeAttached();
});

test('a missing bundle file is a 404, not the page', async ({ request }) => {
  const response = await request.get('/_expo/static/js/web/entry-does-not-exist.js');
  expect(response.status()).toBe(404);
});
