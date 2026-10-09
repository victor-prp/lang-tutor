import { describe, expect, it, jest } from '@jest/globals';

import { EmailNotSent } from '../errors';
import { createResendMailer, signInEmail } from './resend';

const okFetch = () =>
  jest.fn(async (_url: string, _init: RequestInit) => new Response('{"id":"m1"}', { status: 200 }));

describe('signInEmail', () => {
  it('puts the code in the subject and names no app', () => {
    const mail = signInEmail('27508997');
    expect(mail.subject).toBe('קוד הכניסה שלך: 27508997');
    expect(mail.text).toBe(
      'קוד הכניסה שלך הוא 27508997.\nהקוד בתוקף ל-10 דקות.\nאם לא ביקשת אותו, אפשר להתעלם מהמייל הזה.',
    );
    expect(mail.html).toContain('27508997');
    expect(mail.html).toContain('dir="rtl"');
  });

  // Every line is right-to-left Hebrew. Two digit groups separated by anything
  // the bidi algorithm treats as neutral are drawn in swapped order, so
  // "2750 8997" read as 8997 2750 and the learner typed a wrong code. One
  // unbroken run of digits is drawn in order everywhere.
  it('never separates the digits, so right-to-left text cannot reorder them', () => {
    const mail = signInEmail('27508997');
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).toContain('27508997');
      expect(part).not.toMatch(/2750\D+8997/);
    }
  });
});

describe('createResendMailer', () => {
  it('posts one email to /emails with the bearer key', async () => {
    const fetch = okFetch();
    const mailer = createResendMailer({
      fetch: fetch as unknown as typeof globalThis.fetch,
      baseUrl: 'http://mock/ns',
      apiKey: 'key-1',
      from: 'WordsPal <code@wordspal.ai>',
      timeoutMs: 10_000,
    });

    await mailer.sendSignInCode('learner@example.com', '12345678');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://mock/ns/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key-1');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from: 'WordsPal <code@wordspal.ai>',
      to: ['learner@example.com'],
      subject: 'קוד הכניסה שלך: 12345678',
    });
  });

  it('turns a refusal into EmailNotSent carrying the status', async () => {
    const fetch = jest.fn(async () => new Response('{"message":"nope"}', { status: 422 }));
    const mailer = createResendMailer({
      fetch: fetch as unknown as typeof globalThis.fetch,
      baseUrl: 'http://mock',
      apiKey: 'k',
      from: 'f@example.com',
      timeoutMs: 10_000,
    });
    await expect(mailer.sendSignInCode('a@example.com', '12345678')).rejects.toEqual(new EmailNotSent(422));
  });

  it('turns a network failure into EmailNotSent', async () => {
    const fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const mailer = createResendMailer({
      fetch: fetch as unknown as typeof globalThis.fetch,
      baseUrl: 'http://mock',
      apiKey: 'k',
      from: 'f@example.com',
      timeoutMs: 10_000,
    });
    await expect(mailer.sendSignInCode('a@example.com', '12345678')).rejects.toBeInstanceOf(EmailNotSent);
  });

  it('gives up after its budget', async () => {
    const fetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const mailer = createResendMailer({
      fetch: fetch as unknown as typeof globalThis.fetch,
      baseUrl: 'http://mock',
      apiKey: 'k',
      from: 'f@example.com',
      timeoutMs: 20,
    });
    await expect(mailer.sendSignInCode('a@example.com', '12345678')).rejects.toEqual(new EmailNotSent('timeout'));
  });
});
