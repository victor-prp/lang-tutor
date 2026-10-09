import { EmailNotSent } from '../errors';

/**
 * Phase 29 (spec D16). Resend's HTTP API: one POST per sign-in code. `fetch`
 * is received (ADR 0002), so tests and e2e point `baseUrl` at MockServer
 * exactly as GEMINI_BASE_URL is. Only composition.ts imports this file
 * (ADR 0001 R11).
 */
export const RESEND_TIMEOUT_MS = 10_000;

const split = (code: string): string => `${code.slice(0, 4)} ${code.slice(4)}`;

/** Hebrew, and names no app: the app is still called "lang tutor" (spec D16). */
export function signInEmail(code: string): { subject: string; text: string; html: string } {
  const shown = split(code);
  const lines = [`קוד הכניסה שלך הוא ${shown}.`, 'הקוד בתוקף ל-10 דקות.', 'אם לא ביקשת אותו, אפשר להתעלם מהמייל הזה.'];
  return {
    subject: `קוד הכניסה שלך: ${shown}`,
    text: lines.join('\n'),
    html:
      `<div dir="rtl" style="font-family:sans-serif;font-size:16px">` +
      `<p>קוד הכניסה שלך הוא <strong style="font-size:24px;letter-spacing:2px">${shown}</strong>.</p>` +
      `<p>${lines[1]}</p><p>${lines[2]}</p></div>`,
  };
}

export function createResendMailer({
  fetch,
  baseUrl,
  apiKey,
  from,
  timeoutMs,
}: {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  from: string;
  timeoutMs: number;
}) {
  return {
    sendSignInCode: async (email: string, code: string): Promise<void> => {
      const mail = signInEmail(code);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [email], subject: mail.subject, text: mail.text, html: mail.html }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new EmailNotSent(timedOut ? 'timeout' : 'network');
      }
      if (!res.ok) throw new EmailNotSent(res.status);
    },
  };
}
