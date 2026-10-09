import { EmailNotSent } from '../errors';

/**
 * Phase 29 (spec D16). Resend's HTTP API: one POST per sign-in code. `fetch`
 * is received (ADR 0002), so tests and e2e point `baseUrl` at MockServer
 * exactly as GEMINI_BASE_URL is. Only composition.ts imports this file
 * (ADR 0001 R11).
 */
export const RESEND_TIMEOUT_MS = 10_000;

/**
 * Hebrew, and names no app: the app is still called "lang tutor" (spec D16).
 *
 * The code is one unbroken run of digits. Every line here is right-to-left,
 * and two digit groups with a space between them are drawn in swapped order:
 * "2750 8997" showed as 8997 2750, and the learner typed a wrong code. The
 * HTML spaces the digits with CSS, which adds no character between them.
 */
export function signInEmail(code: string): { subject: string; text: string; html: string } {
  const lines = [`קוד הכניסה שלך הוא ${code}.`, 'הקוד בתוקף ל-10 דקות.', 'אם לא ביקשת אותו, אפשר להתעלם מהמייל הזה.'];
  return {
    subject: `קוד הכניסה שלך: ${code}`,
    text: lines.join('\n'),
    html:
      `<div dir="rtl" style="font-family:sans-serif;font-size:16px">` +
      `<p>קוד הכניסה שלך הוא <strong style="font-size:24px;letter-spacing:4px">${code}</strong>.</p>` +
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
