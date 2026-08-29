import type { Page } from '@playwright/test';

export type Diagnostics = {
  pageErrors: string[];
  consoleErrors: string[];
  apiRequests: string[];
  failedRequests: string[];
};

/**
 * The app swallows every API failure: useSession catches it and calls
 * Alert.alert, which react-native-web implements as a literal no-op. So a
 * broken URL or a dead server produces no dialog, no page error, and no
 * visible change — only a test that times out for no stated reason.
 *
 * Recording network traffic is what makes those cases distinguishable:
 * no API request at all means the inlined URL is wrong, a failed request
 * means the server is unreachable, and a successful request with an
 * unchanged UI is a genuine client bug.
 */
export function attachDiagnostics(page: Page, apiUrl: string): Diagnostics {
  const d: Diagnostics = {
    pageErrors: [],
    consoleErrors: [],
    apiRequests: [],
    failedRequests: [],
  };

  page.on('pageerror', (error) => d.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') d.consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.url().startsWith(apiUrl)) {
      d.apiRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    d.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`);
  });

  return d;
}

/** Rendered into assertion messages so a failure explains itself. */
export function diagnosticReport(d: Diagnostics): string {
  const lines = [
    `API requests seen (${d.apiRequests.length}):`,
    ...d.apiRequests.map((r) => `  ${r}`),
    `Failed requests (${d.failedRequests.length}):`,
    ...d.failedRequests.map((r) => `  ${r}`),
    `Page errors (${d.pageErrors.length}):`,
    ...d.pageErrors.map((r) => `  ${r}`),
    `Console errors (${d.consoleErrors.length}):`,
    ...d.consoleErrors.map((r) => `  ${r}`),
  ];
  if (d.apiRequests.length === 0) {
    lines.push(
      'NOTE: zero API requests. The bundle probably has the wrong EXPO_PUBLIC_API_URL',
      '      inlined — rebuild the export with it set explicitly.',
    );
  }
  return lines.join('\n');
}
