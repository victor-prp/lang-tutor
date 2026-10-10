import type { VocabularyWordDetail } from '@lang-tutor/core/api';
import { expect, test, type APIRequestContext } from '@playwright/test';

import { API_URL } from '../urls';
import { generationStub } from './support/cards';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { FINGER, FINGER_RECONCILED, FINGERS, MOUSE } from './support/lexemes';
import { clearGemini, expectGeminiMatching, expectGeminiPayload, userText } from './support/mockServer';
import { answerChoiceRight, askedForm, enrollmentIdOf, readyListSession, skipSession } from './support/sessions';
import { openApp, signUpLearner } from './support/users';

// Phase 31, the spec's three e2e lines. MockServer is set up through the
// `request` fixture; the API is called through `page.request`, which carries
// the signed-in learner's cookie (phase 29).

test.setTimeout(240_000);

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

async function wordDetail(request: APIRequestContext, enrollmentId: string, lemma: string) {
  const res = await request.get(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary/word?lemma=${encodeURIComponent(lemma)}`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as VocabularyWordDetail;
}

test('two senses with one target word are one card, saved once, practised once, at one level', async ({ page, request }) => {
  await signUpLearner(page, 'e2e_gloss_mouse', 'en');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await tapUntil(page, 'translate-entry', 'translate-input');

  await lookUp(page, request, 'mouse', MOUSE);
  await expect(page.getByTestId('translate-sense')).toHaveCount(1);
  await expect(page.getByTestId('translate-example')).toHaveCount(2);
  // The key is the translation itself, so no key line; the rodent's other word
  // is the card's "also" line.
  await expect(page.getByTestId('translate-key')).toHaveCount(0);
  await expect(page.getByTestId('translate-also')).toHaveText('גם: עכברון');
  await tapAndWaitForWrite(page, page.getByTestId('translate-save'));

  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  await expect(page.getByTestId('vocabulary-word')).toHaveCount(1);
  await page.getByTestId('vocabulary-word').first().click();
  await expect(page.getByTestId('vocabulary-sense')).toHaveCount(1);
  await expect(page.getByTestId('vocabulary-sense-example')).toHaveCount(2);
  await expect(page.getByTestId('vocabulary-sense-also')).toHaveText('גם: עכברון');
  await expect(page.getByTestId('vocabulary-sense-level')).toHaveCount(1);

  // Practised once: one card in the session, and one level when it ends.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStub());
  const session = await readyListSession(page.request, enrollmentId);
  expect(session.total).toBe(1);
  expect(askedForm(session.question)).toBe('mouse');
  const done = await answerChoiceRight(page.request, session.id, session.question);
  expect(done.complete).toBe(true);
  if (done.complete) expect(done.progress).toHaveLength(1);

  // Read over the API: the word's page on screen was read before the session.
  const detail = await wordDetail(page.request, enrollmentId, 'mouse');
  expect(detail.senses).toHaveLength(1);
  expect(detail.senses[0].progress).toBeDefined();
});

test('a word saved from fingers headlines אצבע and says where it was saved from, and once its lemma is rendered a session asks finger', async ({
  page,
  request,
}) => {
  await signUpLearner(page, 'e2e_gloss_finger', 'en');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await tapUntil(page, 'translate-entry', 'translate-input');

  await lookUp(page, request, 'fingers', FINGERS);
  // The card reads the typed form, with the gloss's key beneath it.
  await expect(page.getByTestId('translate-key')).toHaveText('אצבע');
  // The save asks for the render-lemma job, which looks `finger` up: the first
  // call, then the rendering call for the stored sense. Both send `finger` as
  // their text, so the rendering call's marker ranks first.
  await expectGeminiMatching(request, 'reusing its sense_code EXACTLY', FINGER_RECONCILED, { priority: 20 });
  await expectGeminiMatching(request, userText('finger'), FINGER, { priority: 10 });
  await tapAndWaitForWrite(page, page.getByTestId('translate-save'));

  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const word = page.getByTestId('vocabulary-word').first();
  await expect(word).toContainText('finger');
  await expect(word).not.toContainText('fingers');
  await expect(word).toContainText('אצבע');
  await expect(word).not.toContainText('אצבעות');
  await word.click();
  // The word's page headlines the key too, and says which form was saved.
  await expect(page.getByTestId('vocabulary-sense').getByText('אצבע', { exact: true })).toBeVisible();
  await expect(page.getByTestId('vocabulary-sense-saved-from')).toContainText('fingers');
  await expect(page.getByTestId('vocabulary-sense-saved-from')).toContainText('אצבעות');

  // The job has run once the word's page takes its example from the lemma form.
  await expect(async () => {
    const detail = await wordDetail(page.request, enrollmentId, 'finger');
    expect(detail.senses[0].examples[0].source).toBe('She pointed with one finger.');
  }).toPass({ timeout: 60_000 });

  // Each session asks one agreeing rendering at random (spec D12): `fingers` or
  // `finger`. Ten sessions miss `finger` once in 1024 runs.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStub());
  const asked = new Set<string>();
  for (let attempt = 0; attempt < 10 && !asked.has('finger'); attempt++) {
    const session = await readyListSession(page.request, enrollmentId);
    asked.add(askedForm(session.question));
    await skipSession(page.request, session.id);
  }
  for (const form of asked) expect(['finger', 'fingers']).toContain(form);
  expect([...asked]).toContain('finger');
});
