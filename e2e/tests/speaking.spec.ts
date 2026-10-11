import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerMeaning, answerTyped, expectGeneration, readCard, speak, type Card, type CardKind } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { seedMemory, type MemorySeed } from './support/memory';
import { clearGemini, expectGeminiMatching, expectTranscription, userText } from './support/mockServer';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(300_000);
// A granted microphone and Chromium's fake one: the app records, and the
// transcription is MockServer's. No voices, so no listening cards (phase 24 D5).
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

// Four words are enough for every speaking card, and with fewer than seven
// picks a session has no board (ruling 18).
const WORDS = BOARD_WORDS.slice(0, 4);
const FORM_OF: Record<string, string> = Object.fromEntries(WORDS.map((w) => [w.translation, w.form]));
const MEANING_OF: Record<string, string> = Object.fromEntries(WORDS.map((w) => [w.form, w.translation]));

/** Past a skipped seed, with the four words looked up and saved through the API. */
async function saveFourWords(request: APIRequestContext): Promise<void> {
  const enrollments = (await (await request.get(`${API_URL}/api/enrollments`)).json()) as { id: string }[];
  const enrollmentId = enrollments[0].id;
  const seed = (await (await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } })).json()) as {
    session_id: string;
  };
  expect((await request.post(`${API_URL}/api/sessions/${seed.session_id}/skip`)).ok()).toBe(true);
  for (const word of WORDS) {
    await clearGemini(request);
    // Phase 31. Matched on its own text, as lookUp's is: a background render-lemma
    // job from an earlier spec's save may still be calling, and a stub that
    // answered every call would write this word under that lemma.
    await expectGeminiMatching(request, userText(word.form), word.payload);
    const lookup = await request.post(`${API_URL}/api/translations`, {
      data: { text: word.form, from: 'ru', to: 'he', enrollment_id: enrollmentId },
    });
    expect(lookup.ok(), await lookup.text()).toBe(true);
    const { senses } = (await lookup.json()) as { senses: { gloss_id?: string; variant_id?: string }[] };
    const saved = await request.post(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`, {
      data: { entries: senses.map((sense) => ({ gloss_id: sense.gloss_id!, variant_id: sense.variant_id! })) },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
}

/**
 * Phase 35 (spec D5, D6). The memory each session starts from. Speaking on and
 * no voices, so the live dimensions are WR, WP, SP and SK. A read aloud is
 * spoken production at recognition (rung 1), offered only while that level is
 * below 2 (ruling 16); say the translation is its recall (rung 2). Each seeded
 * word is due on the one dimension it has a row for.
 *
 * Session 1:
 * - ромашка: SK at R 0.50 (S 1, 90 days), level 1: a read aloud.
 * - черепаха: SK at R 0.85 (S 10, 19 days), level 3: say the translation.
 * - подушка, зонтик: no memory, new words, a choice of meanings each.
 */
const FIRST: MemorySeed[] = [
  { gloss: 'מרגנית', dimension: 'spoken_productive', stability: 1, daysAgo: 90, level: 1 },
  { gloss: 'צב', dimension: 'spoken_productive', stability: 10, daysAgo: 19, level: 3 },
];

/**
 * Session 2, seeded over what session 1 wrote, so that the read aloud comes
 * before say the translation: the higher p first (spec D6).
 * - подушка: SK at R 0.85 (S 10, 19 days), level 1: a read aloud, p = √0.85 = 0.92.
 * - черепаха: SK at R 0.79 (S 10, 38 days), level 4: say the translation, p = 0.79.
 * - ромашка: WR at R 0.85, level 3: a typed meaning, p = 0.85. Its read aloud in
 *   session 1 took SK to level 2, so it gets no second one.
 * - зонтик: WP at R 0.50 (S 1, 90 days), level 1: a choice of words, p = 0.78.
 */
const SECOND: MemorySeed[] = [
  { gloss: 'כרית', dimension: 'spoken_productive', stability: 10, daysAgo: 19, level: 1 },
  { gloss: 'צב', dimension: 'spoken_productive', stability: 10, daysAgo: 38, level: 4 },
  { gloss: 'מרגנית', dimension: 'written_receptive', stability: 10, daysAgo: 19, level: 3 },
  { gloss: 'מטרייה', dimension: 'written_productive', stability: 1, daysAgo: 90, level: 1 },
];

/** Gets past a card this spec is not about: a choice answered right, a typed
 *  meaning by the saved meaning, which is judged by rule. */
async function pass(page: Page, card: Card) {
  if (card.kind === 'meaning') await answerMeaning(page, MEANING_OF[card.prompt]);
  else await answerChoice(page, card, true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();
}

test("speaking: read aloud, say the translation, and can't speak now", async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_speak_ru', 'ru');
  await saveFourWords(page.request);
  await seedMemory('e2e_speak_ru', FIRST);

  // Session 1: a read aloud, say the translation and two choices, in the order
  // of their p, so each card is answered by its type.
  await clearGemini(request);
  await expectGeneration(request);
  await openApp(page, 'create-button');
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  const kinds: CardKind[] = [];
  for (let position = 1; position <= 4; position++) {
    const card = await readCard(page, position, 4);
    kinds.push(card.kind);
    if (card.kind === 'read') {
      // Read aloud: first not understood, then understood.
      await expectTranscription(request, 'кошка');
      await expectTranscription(request, card.prompt);
      await speak(page);
      await expect(page.getByTestId('speak-notice')).toContainText('לא הבנו');
      await expect(page.getByTestId('speak-notice-heard')).toHaveText(/кошка/);
      await expect(page.getByTestId('feedback-correct')).not.toBeVisible();
      await page.getByTestId('speak-try-again').click();
      await speak(page);
      await expect(page.getByTestId('feedback-title')).toHaveText(/נכון! שמענו:/);
      await expect(page.getByTestId('feedback-line')).toContainText(card.prompt);
      await page.getByTestId('continue-button').click();
    } else if (card.kind === 'say') {
      // Say the translation, understood at once.
      await expectTranscription(request, FORM_OF[card.prompt]);
      await speak(page);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await page.getByTestId('continue-button').click();
    } else {
      await pass(page, card);
    }
  }
  expect(kinds.sort()).toEqual(['choice', 'choice', 'read', 'say']);

  await expect(page.getByText(/דיבור/).first(), report()).toBeVisible();

  // Session 2: "can't speak now" on the read aloud, and say the translation
  // after it renders as the typed card.
  await seedMemory('e2e_speak_ru', SECOND);
  await clearGemini(request);
  await expectGeneration(request);
  await page.getByTestId('results-next-session').click();
  await expect(async () => {
    if ((await page.getByTestId('create-button').count()) > 0) await page.getByTestId('create-button').click({ timeout: 2_000 });
    await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  let position = 1;
  for (; ; position++) {
    expect(position, 'session 2 asked no read aloud').toBeLessThan(4);
    const card = await readCard(page, position, 4);
    if (card.kind === 'read') break;
    expect(card.kind, `position ${position}`).not.toBe('say');
    await pass(page, card);
  }
  // "Can't speak now" passes the card unseen (spec D8 of phase 25): the next
  // card is up, and no banner or Continue came between.
  await page.getByTestId('speak-cant-speak').click();
  await readCard(page, position + 1, 4);
  await expect(page.getByTestId('feedback-title')).toHaveCount(0);
  await expect(page.getByTestId('continue-button')).toHaveCount(0);

  // Say the translation renders as the typed card from now on: черепаха's card
  // is the session's only typed one.
  for (position += 1; ; position++) {
    expect(position, 'session 2 asked no say the translation after the read aloud').toBeLessThanOrEqual(4);
    const card = await readCard(page, position, 4);
    expect(card.kind, `position ${position}`).not.toBe('say');
    if (card.kind === 'typed') {
      expect(card.prompt).toBe('צב');
      await answerTyped(page, FORM_OF[card.prompt]);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await page.getByTestId('continue-button').click();
      break;
    }
    await pass(page, card);
  }
  if (position < 4) await page.getByTestId('session-skip').click();
  await expect(
    page
      .getByTestId('results-score')
      .or(page.getByTestId('create-button'))
      .or(page.getByTestId('start-button'))
      .or(page.getByTestId('preparing-label')),
  ).toBeVisible();

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
