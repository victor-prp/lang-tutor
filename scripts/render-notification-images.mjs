// Phase 75 (spec D4). Draws a reminder's pictures from apps/mobile/assets/notifications/source.html:
// each [data-out] element is screenshotted on a transparent background to its path under
// apps/mobile. Run it after changing the source, from the repository root:
//
//   node scripts/render-notification-images.mjs
//
// It uses the Chromium the e2e suite installs (npx playwright install chromium).
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

const mobile = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'mobile');
const source = join(mobile, 'assets', 'notifications', 'source.html');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(source).href);
  for (const element of await page.$$('[data-out]')) {
    const out = join(mobile, await element.getAttribute('data-out'));
    await element.screenshot({ path: out, omitBackground: true });
    console.log(out);
  }
} finally {
  await browser.close();
}
