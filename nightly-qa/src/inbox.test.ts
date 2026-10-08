import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mailsFrom, renderInbox } from './inbox.ts';

// The body the server's Resend provider posts (apps/server/src/providers/resend.ts).
const sent = (to: string[], subject: string, text = 'קוד הכניסה שלך הוא 1234 5678.') => ({
  from: 'WordsPal QA <qa@example.com>',
  to,
  subject,
  text,
  html: '<p>ignored</p>',
});

test('a Resend send becomes one message per recipient, the address lower-cased', () => {
  assert.deepEqual(mailsFrom(sent(['QA1@Example.com', 'qa2@example.com'], 'קוד הכניסה שלך: 1234 5678')), [
    { to: 'qa1@example.com', subject: 'קוד הכניסה שלך: 1234 5678', text: 'קוד הכניסה שלך הוא 1234 5678.' },
    { to: 'qa2@example.com', subject: 'קוד הכניסה שלך: 1234 5678', text: 'קוד הכניסה שלך הוא 1234 5678.' },
  ]);
  assert.deepEqual(mailsFrom({ to: 'one@example.com', subject: 's' }), [{ to: 'one@example.com', subject: 's', text: '' }]);
});

test('anything that is not a send is refused', () => {
  for (const body of [null, 'x', {}, { to: [], subject: 's' }, { to: [1], subject: 's' }, { to: ['a@example.com'] }]) {
    assert.equal(mailsFrom(body), null);
  }
});

test("the inbox page lists one address's messages, newest first, and no one else's", () => {
  const mails = [
    ...mailsFrom(sent(['qa@example.com'], 'קוד הכניסה שלך: 1111 1111'))!,
    ...mailsFrom(sent(['other@example.com'], 'קוד הכניסה שלך: 2222 2222'))!,
    ...mailsFrom(sent(['qa@example.com'], 'קוד הכניסה שלך: 3333 3333'))!,
  ];
  const page = renderInbox('QA@example.com', mails);
  assert.ok(page.indexOf('3333 3333') < page.indexOf('1111 1111'), 'newest first');
  assert.ok(page.includes('1111 1111'));
  assert.ok(!page.includes('2222 2222'));
  assert.ok(page.includes('קוד הכניסה שלך הוא 1234 5678.'));
});

test('the inbox page says when nothing has arrived, and escapes what it shows', () => {
  assert.match(renderInbox('qa@example.com', []), /No messages yet/);
  const page = renderInbox('qa@example.com', mailsFrom(sent(['qa@example.com'], '<b>&</b>', '<script>x</script>'))!);
  assert.ok(page.includes('&lt;b&gt;&amp;&lt;/b&gt;'));
  assert.ok(!page.includes('<script>'));
});
