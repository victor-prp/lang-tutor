import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerTyped, generationStubFor, readCard, speak } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { skipListSession, tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini, expectGemini, expectGeminiPayload, expectTranscription } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(300_000);
// A granted microphone and Chromium's fake one: the app records, and the
// transcription is MockServer's. No voices, so no listening cards (phase 24 D5).
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

const MEANING_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.form, w.translation]));
const FORM_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.translation, w.form]));

/** Past a skipped seed, with the ten words looked up and saved through the API. */
async function saveTenWords(request: APIRequestContext, userId: string): Promise<string> {
  const enrollments = (await (await request.get(`${API_URL}/api/users/${userId}/enrollments`)).json()) as { id: string }[];
  const enrollmentId = enrollments[0].id;
  const seed = (await (await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } })).json()) as {
    session_id: string;
  };
  expect((await request.post(`${API_URL}/api/sessions/${seed.session_id}/skip`)).ok()).toBe(true);
  for (const word of BOARD_WORDS) {
    await clearGemini(request);
    await expectGemini(request, word.payload);
    const lookup = await request.post(`${API_URL}/api/translations`, {
      data: { text: word.form, from: 'ru', to: 'he', enrollment_id: enrollmentId },
    });
    expect(lookup.ok(), await lookup.text()).toBe(true);
    const { senses } = (await lookup.json()) as { senses: { gloss_id?: string; variant_id?: string }[] };
    const saved = await request.post(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`, {
      headers: { 'X-Acting-User-Id': userId },
      data: { entries: senses.map((sense) => ({ gloss_id: sense.gloss_id!, variant_id: sense.variant_id! })) },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  return enrollmentId;
}

/** Builds the word on the tiles card from its tiles. */
async function buildWord(page: Page, word: string) {
  const count = await page.getByTestId(/^tile-\d+$/).count();
  const tiles = await Promise.all(Array.from({ length: count }, async (_, i) => (await page.getByTestId(`tile-${i}`).textContent()) ?? ''));
  const used = new Set<number>();
  for (const letter of word) {
    const index = tiles.findIndex((tile, i) => tile === letter && !used.has(i));
    used.add(index);
    await page.getByTestId(`tile-${index}`).click();
  }
  await page.getByTestId('tiles-submit').click();
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
}

test("speaking: read aloud, say the translation, and can't speak now", async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  const user = await createLearner(request, 'e2e_speak_ru', 'ru');
  const enrollmentId = await saveTenWords(request, user.id);
  // A list session made and skipped first, so the one played is ordinal 1.
  await skipListSession(request, enrollmentId);

  // Session 1, ordinal 1, speaking on and listening off. Tiers [multiple_choice,
  // read_aloud, typed_meaning], [reverse_choice, cloze_choice, letter_tiles],
  // [typed_translation, cloze_typed, say_translation, sentence_translation]
  // (listen_choice and dictation ineligible). Six singles and a board at 4-7;
  // single s is tier s % 3, run floor(s / 3), prefers (1 + run) % length:
  //   1 (s0) prefers listen_choice -> read aloud   2 (s1) prefers cloze_choice (no example) -> tiles
  //   3 (s2) prefers cloze_typed, its sentence unanswered by the stub -> typed_translation
  //   8 (s3) run 1 prefers index 2 -> read aloud   9 (s4) prefers index 2 -> tiles
  //   10 (s5) prefers index 2, dictation ineligible -> say the translation.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStubFor({ 3: 'typed', 4: 'meaning', 10: 'typed' }));
  await page.goto('/');
  await page.getByTestId('login-username').fill('e2e_speak_ru');
  await expect(async () => {
    if ((await page.getByTestId('login-button').count()) > 0) await page.getByTestId('login-button').click({ timeout: 2_000 });
    await expect(page.getByTestId('create-button')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  // 1: read aloud. First not understood, then understood.
  const read = await readCard(page, 1, 10, 'read');
  await expectTranscription(request, 'кошка');
  await expectTranscription(request, read.prompt);
  await speak(page);
  await expect(page.getByTestId('speak-notice')).toContainText('לא הבנו');
  await expect(page.getByTestId('speak-notice-heard')).toHaveText(/кошка/);
  await expect(page.getByTestId('feedback-correct')).not.toBeVisible();
  await page.getByTestId('speak-try-again').click();
  await speak(page);
  await expect(page.getByTestId('feedback-title')).toHaveText(/נכון! שמענו:/);
  await expect(page.getByTestId('feedback-line')).toContainText(read.prompt);
  await page.getByTestId('continue-button').click();

  // 2: tiles.
  const tiles1 = await readCard(page, 2, 10, 'tiles');
  await buildWord(page, FORM_OF[tiles1.prompt]);
  await page.getByTestId('continue-button').click();

  // 3: typed (the sentence card's degraded form).
  const typed = await readCard(page, 3, 10, 'typed');
  await answerTyped(page, FORM_OF[typed.prompt]);
  await page.getByTestId('continue-button').click();

  await readCard(page, 4, 10, 'board');
  const words = await Promise.all([0, 1, 2, 3].map(async (i) => stripIsolates(await page.getByTestId(`board-word-${i}`).textContent())));
  const meanings = await Promise.all(
    [0, 1, 2, 3, 4].map(async (i) => stripIsolates(await page.getByTestId(`board-meaning-${i}`).textContent())),
  );
  for (const [i, word] of words.entries()) {
    await page.getByTestId(`board-word-${i}`).click();
    await page.getByTestId(`board-meaning-${meanings.indexOf(MEANING_OF[word])}`).click();
  }
  await expect(page.getByTestId('feedback-title')).toHaveText(/4\s*מתוך\s*4/);
  await page.getByTestId('continue-button').click();

  // 8: read aloud, understood at once.
  const read2 = await readCard(page, 8, 10, 'read');
  await expectTranscription(request, read2.prompt);
  await speak(page);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  // 9: tiles.
  const tilesCard = await readCard(page, 9, 10, 'tiles');
  await buildWord(page, FORM_OF[tilesCard.prompt]);
  await page.getByTestId('continue-button').click();

  // 10: say the translation.
  const say = await readCard(page, 10, 10, 'say');
  await expectTranscription(request, FORM_OF[say.prompt]);
  await speak(page);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  await expect(page.getByText(/דיבור/).first(), report()).toBeVisible();

  // Session 2, ordinal 2 (the prefers shift by one): 1 read aloud, 2 tiles, 3 say the translation, 4-7
  // board, 8 meaning recall, 9 reverse, 10 say the translation.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStubFor({ 3: 'typed', 4: 'meaning', 9: 'word', 10: 'typed' }));
  await page.getByTestId('results-next-session').click();
  await expect(async () => {
    if ((await page.getByTestId('create-button').count()) > 0) await page.getByTestId('create-button').click({ timeout: 2_000 });
    await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  // 1: "can't speak now" passes the card unseen, and the 2nd is tiles.
  await readCard(page, 1, 10, 'read');
  await page.getByTestId('speak-cant-speak').click();
  const tiles2 = await readCard(page, 2, 10, 'tiles');
  // Passed unseen (spec D8): card 2 is up, and no banner or Continue came between.
  await expect(page.getByTestId('feedback-title')).toHaveCount(0);
  await expect(page.getByTestId('continue-button')).toHaveCount(0);
  await buildWord(page, FORM_OF[tiles2.prompt]);
  await page.getByTestId('continue-button').click();

  // 3: say the translation renders as the typed card from now on.
  const typed2 = await readCard(page, 3, 10, 'typed');
  await answerTyped(page, FORM_OF[typed2.prompt]);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('create-button').or(page.getByTestId('start-button')).or(page.getByTestId('preparing-label'))).toBeVisible();

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
