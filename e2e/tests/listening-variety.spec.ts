import { expect, test, type APIRequestContext } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerTyped, generationStubFor, readCard } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini, expectGemini, expectGeminiPayload } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner } from './support/users';
import { spoken, spokenAfter, withVoices } from './support/voices';

test.setTimeout(240_000);

const MEANING_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.form, w.translation]));
const FORM_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.translation, w.form]));

/** Past a skipped seed, with the ten words looked up and saved through the API. */
async function saveTenWords(request: APIRequestContext, userId: string): Promise<void> {
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
    const { senses } = (await lookup.json()) as { senses: { sense_id?: string; variant_id?: string }[] };
    const saved = await request.post(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`, {
      headers: { 'X-Acting-User-Id': userId },
      data: { entries: senses.map((sense) => ({ sense_id: sense.sense_id!, variant_id: sense.variant_id! })) },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
}

test('ten words: a run, a board, a listening card, tiles and a dictation', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, ['ru-RU']);
  const user = await createLearner(request, 'e2e_listen_ru', 'ru');
  await saveTenWords(request, user.id);

  // Ordinal 0, listening on (spec D3): q1 meaning, q2 word, q3 typed, q4 the
  // board's wrong meanings, q8 the listening card's. Nothing else is asked.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStubFor({ 1: 'meaning', 2: 'word', 3: 'typed', 4: 'meaning', 8: 'meaning' }));
  // Past a skipped seed the home screen offers create, not start, so logIn's wait does not fit.
  await page.goto('/');
  await page.getByTestId('login-username').fill('e2e_listen_ru');
  await expect(async () => {
    if ((await page.getByTestId('login-button').count()) > 0) await page.getByTestId('login-button').click({ timeout: 2_000 });
    await expect(page.getByTestId('create-button')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  // 1–3: the first run.
  await answerChoice(page, await readCard(page, 1, 10, 'choice'), true);
  await page.getByTestId('continue-button').click();
  await answerChoice(page, await readCard(page, 2, 10, 'reverse'), true);
  await page.getByTestId('continue-button').click();
  const typed = await readCard(page, 3, 10, 'typed');
  await answerTyped(page, FORM_OF[typed.prompt]);
  await page.getByTestId('continue-button').click();

  // 4–7: the board. One wrong pairing for the first word, then every word right.
  await readCard(page, 4, 10, 'board');
  const words = await Promise.all([0, 1, 2, 3].map(async (i) => stripIsolates(await page.getByTestId(`board-word-${i}`).textContent())));
  const meanings = await Promise.all(
    [0, 1, 2, 3, 4].map(async (i) => stripIsolates(await page.getByTestId(`board-meaning-${i}`).textContent())),
  );
  await page.getByTestId('board-word-0').click();
  await page.getByTestId(`board-meaning-${meanings.findIndex((m) => m !== MEANING_OF[words[0]])}`).click();
  for (const [i, word] of words.entries()) {
    await page.getByTestId(`board-word-${i}`).click();
    await page.getByTestId(`board-meaning-${meanings.indexOf(MEANING_OF[word])}`).click();
  }
  await expect(page.getByTestId('feedback-title')).toHaveText(/3\s*מתוך\s*4/);
  const beforeListen = (await spoken(page)).length;
  await page.getByTestId('continue-button').click();

  // 8: the word is spoken on arrival and not shown; pick its meaning.
  const listen = await readCard(page, 8, 10, 'listen');
  const heard = await spokenAfter(page, beforeListen);
  expect(heard.lang).toBe('ru-RU');
  await page.getByTestId(`option-${listen.options.indexOf(MEANING_OF[heard.text])}`).click();
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('question-prompt')).toHaveText(heard.text);
  await page.getByTestId('continue-button').click();

  // 9: build the word from its tiles.
  const tilesCard = await readCard(page, 9, 10, 'tiles');
  const count = await page.getByTestId(/^tile-\d+$/).count();
  const tiles = await Promise.all(Array.from({ length: count }, async (_, i) => (await page.getByTestId(`tile-${i}`).textContent()) ?? ''));
  const used = new Set<number>();
  for (const letter of FORM_OF[tilesCard.prompt]) {
    const index = tiles.findIndex((tile, i) => tile === letter && !used.has(i));
    used.add(index);
    await page.getByTestId(`tile-${index}`).click();
  }
  await page.getByTestId('tiles-submit').click();
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  const beforeDictation = (await spoken(page)).length;
  await page.getByTestId('continue-button').click();

  // 10: hear it, type it.
  await readCard(page, 10, 10, 'dictation');
  const dictated = await spokenAfter(page, beforeDictation);
  await answerTyped(page, dictated.text);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  // Results: listening is practice now (spec D13).
  await expect(page.getByText(/הבנת הנשמע/).first(), report()).toBeVisible();
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
