/**
 * Nightly QA's local inbox (phase 29). The app signs a learner in with a code
 * sent by email, through Resend's HTTP API. up.sh points the server's
 * RESEND_BASE_URL at mail-sink.ts, which keeps every message it is sent and
 * shows one address's messages as a page the QA agent's browser can read.
 * These are its pure parts; mail-sink.ts is the server around them.
 */
export type Mail = { to: string; subject: string; text: string };

/** Resend's `POST /emails` body as one message per recipient, addresses lower-cased; null when it is not a send. */
export function mailsFrom(body: unknown): Mail[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { to, subject, text } = body as Record<string, unknown>;
  const recipients: unknown[] | null = typeof to === 'string' ? [to] : Array.isArray(to) ? to : null;
  if (!recipients || recipients.length === 0) return null;
  if (!recipients.every((r): r is string => typeof r === 'string') || typeof subject !== 'string') return null;
  return recipients.map((r) => ({
    to: r.trim().toLowerCase(),
    subject,
    text: typeof text === 'string' ? text : '',
  }));
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One address's messages, newest first, as a minimal page. */
export function renderInbox(address: string, mails: readonly Mail[]): string {
  const wanted = address.trim().toLowerCase();
  const mine = mails.filter((m) => m.to === wanted).reverse();
  const body = mine.length
    ? `<ol>\n${mine
        .map((m) => `<li><h2>${escapeHtml(m.subject)}</h2><pre>${escapeHtml(m.text)}</pre></li>`)
        .join('\n')}\n</ol>`
    : '<p>No messages yet. Ask the app for a code, then reload this page.</p>';
  return [
    '<!doctype html>',
    '<html dir="auto"><head><meta charset="utf-8">',
    `<title>Inbox: ${escapeHtml(wanted)}</title></head>`,
    `<body><h1>Inbox: ${escapeHtml(wanted)}</h1>`,
    body,
    '</body></html>',
  ].join('\n');
}
