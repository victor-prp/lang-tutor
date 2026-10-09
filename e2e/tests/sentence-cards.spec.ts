import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import {
  STUB_GAP,
  STUB_GAP_LEMMA,
  STUB_SENTENCE,
  answerChoice,
  answerTyped,
  generationStubFor,
  readCard,
  rightOption,
} from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { skipListSession, tapUntil } from './support/interactions';
import { clearGemini, expectGeminiMatching, expectGeminiPayload, expectJudge, userText } from './support/mockServer';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(240_000);

// Six saved senses of six words, each with a dictionary example holding its form
// once, so `cloze_choice` is eligible for every pick. None is in the seed or in
// another spec; none is one of the stub's wrong words.
const word = (form: string, meaning: string, code: string, source: string, target: string) => ({
  form,
  meaning,
  payload: {
    kind: 'word' as const,
    entries: [
      { lemma: form, part_of_speech: 'noun', senses: [{ translation: meaning, sense_code: code, example: { source, target } }] },
    ],
  },
});

const WORDS = [
  word('бабочка', 'פרפר', 'butterfly', 'Красивая бабочка села на цветок.', 'פרפר יפה נחת על פרח.'),
  word('облако', 'ענן', 'cloud', 'Над морем плыло белое облако.', 'מעל הים שט ענן לבן.'),
  word('дорога', 'דרך', 'road', 'Эта дорога ведёт к реке.', 'הדרך הזאת מובילה אל הנהר.'),
  word('корзина', 'סל', 'basket', 'Корзина стоит на кухне.', 'הסל עומד במטבח.'),
  word('ракушка', 'צדף', 'shell', 'На берегу лежит ракушка.', 'על החוף שוכב צדף.'),
  word('варежка', 'כפפה', 'mitten', 'Варежка лежит на полу.', 'הכפפה שוכבת על הרצפה.'),
];
const FORM_OF: Record<string, string> = Object.fromEntries(WORDS.map((w) => [w.meaning, w.form]));
const FORMS = WORDS.map((w) => w.form);

/** Past a skipped seed, the six words looked up and saved through the API. */
async function saveSixWords(request: APIRequestContext): Promise<string> {
  const enrollments = (await (await request.get(`${API_URL}/api/enrollments`)).json()) as { id: string }[];
  const enrollmentId = enrollments[0].id;
  const seed = (await (await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } })).json()) as {
    session_id: string;
  };
  expect((await request.post(`${API_URL}/api/sessions/${seed.session_id}/skip`)).ok()).toBe(true);
  for (const w of WORDS) {
    await clearGemini(request);
    // Phase 31. Matched on its own text, as lookUp's is: a background render-lemma
    // job from an earlier spec's save may still be calling, and a stub that
    // answered every call would write this word under that lemma.
    await expectGeminiMatching(request, userText(w.form), w.payload);
    const lookup = await request.post(`${API_URL}/api/translations`, {
      data: { text: w.form, from: 'ru', to: 'he', enrollment_id: enrollmentId },
    });
    expect(lookup.ok(), await lookup.text()).toBe(true);
    const { senses } = (await lookup.json()) as { senses: { gloss_id?: string; variant_id?: string }[] };
    const saved = await request.post(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`, {
      data: { entries: senses.map((sense) => ({ gloss_id: sense.gloss_id!, variant_id: sense.variant_id! })) },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  return enrollmentId;
}

/** Builds the word on the tiles card from its tiles. */
async function buildWord(page: Page, letters: string) {
  const count = await page.getByTestId(/^tile-\d+$/).count();
  const tiles = await Promise.all(Array.from({ length: count }, async (_, i) => (await page.getByTestId(`tile-${i}`).textContent()) ?? ''));
  const used = new Set<number>();
  for (const letter of letters) {
    const index = tiles.findIndex((tile, i) => tile === letter && !used.has(i));
    expect(index, `tile for ${letter}`).toBeGreaterThanOrEqual(0);
    used.add(index);
    await page.getByTestId(`tile-${index}`).click();
  }
  await page.getByTestId('tiles-submit').click();
}

/**
 * Six saved words, a first list session made and skipped so the next one is
 * ordinal 1, and that one started. No voices, speaking off (e2e Chromium), so
 * the tiers are [multiple_choice, listen_choice, typed_meaning], [reverse_choice,
 * cloze_choice, letter_tiles] and [typed_translation, cloze_typed, dictation,
 * sentence_translation], with listen_choice and dictation ineligible (D9).
 * Six picks, so no board. Single card s is tier s % 3 at run floor(s / 3) and
 * prefers index (ordinal + run) % length, falling through to the next eligible:
 *   1 (s0) tier 0, prefers 1 listen_choice          -> typed_meaning
 *   2 (s1) tier 1, prefers 1                        -> cloze_choice
 *   3 (s2) tier 2, prefers 1                        -> cloze_typed
 *   4 (s3) tier 0, run 1, prefers 2                 -> typed_meaning
 *   5 (s4) tier 1, run 1, prefers 2                 -> letter_tiles
 *   6 (s5) tier 2, run 1, prefers 2 dictation       -> sentence_translation
 * The model is asked at 2 (gap), 3 (sentence) and 6 (translate).
 */
async function reachSentenceSession(page: Page, request: APIRequestContext, username: string) {
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  const enrollmentId = await saveSixWords(page.request);

  await skipListSession(page.request, enrollmentId);

  await clearGemini(request);
  await expectGeminiPayload(request, generationStubFor({ 2: 'gap', 3: 'sentence', 6: 'translate' }));
  // Past a skipped seed the home screen offers create, not start, so openApp's default landing does not fit.
  await openApp(page, 'create-button');
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  // 1: typed_meaning, passed by showing the answer.
  await readCard(page, 1, 6, 'meaning');
  await page.getByTestId('typed-show-answer').click();
  await page.getByTestId('continue-button').click();
}

test('the sentence cards: a gap to choose, a gap to type, a sentence to translate', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await reachSentenceSession(page, request, 'e2e_sentences_ru');

  // 2: the saved example with its word blanked; no Hebrew until it is answered.
  const choice = await readCard(page, 2, 6, 'cloze-choice');
  await expect(page.getByText('איזו מילה חסרה?')).toBeVisible();
  const blanked = stripIsolates(await page.getByTestId('sentence-gap').textContent());
  expect(blanked).toContain('_____');
  expect(FORMS.some((form) => blanked.toLowerCase().includes(form)), blanked).toBe(false);
  await expect(page.getByTestId('sentence-translation')).toHaveCount(0);
  // The right option is the text at the gap, so a sentence-initial word keeps its capital.
  expect(choice.options.filter((text) => FORMS.includes(text.toLowerCase()))).toHaveLength(1);
  const right = rightOption(choice);
  expect(FORMS).toContain(right.toLowerCase());
  await answerChoice(page, choice, true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('sentence-translation')).toHaveText(/\p{Script=Hebrew}/u);
  await expect(page.getByTestId('sentence-gap')).toContainText(right);
  await page.getByTestId('continue-button').click();

  // 3: a new sentence, its Hebrew always shown. Its gap is inflected, so the
  // lemma is a wrong answer and the form the right one.
  await readCard(page, 3, 6, 'cloze-typed');
  await expect(page.getByText('השלימו את המילה החסרה ברוסית')).toBeVisible();
  expect(stripIsolates(await page.getByTestId('sentence-gap').textContent())).toBe('Вчера она _____ эту книгу');
  await expect(page.getByTestId('sentence-translation')).toBeVisible();
  await answerTyped(page, STUB_GAP);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון!');
  await page.getByTestId('continue-button').click();

  // 4: typed_meaning again; 5: letter_tiles.
  await readCard(page, 4, 6, 'meaning');
  await page.getByTestId('typed-show-answer').click();
  await page.getByTestId('continue-button').click();
  const tiles = await readCard(page, 5, 6, 'tiles');
  await buildWord(page, FORM_OF[tiles.prompt]);
  await page.getByTestId('continue-button').click();

  // 6: translate the Hebrew sentence; a different order is the judge's to accept.
  await readCard(page, 6, 6, 'translate');
  await expect(page.getByText('תרגמו לרוסית')).toBeVisible();
  await expect(page.getByTestId('translation-reference')).toHaveCount(0);
  await expectJudge(request, 'right');
  await answerTyped(page, 'Она прочитала эту книгу вчера');
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון!');
  await expect(page.getByText('תרגום לדוגמה:')).toBeVisible();
  expect(stripIsolates(await page.getByTestId('translation-reference').textContent())).toBe(STUB_SENTENCE);
  await page.getByTestId('continue-button').click();

  await expect(page.getByTestId('results-score')).toBeVisible();
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('a typed gap refuses the lemma of its inflected word', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await reachSentenceSession(page, request, 'e2e_sentences_lemma_ru');

  await answerChoice(page, await readCard(page, 2, 6, 'cloze-choice'), true);
  await page.getByTestId('continue-button').click();

  await readCard(page, 3, 6, 'cloze-typed');
  await answerTyped(page, STUB_GAP_LEMMA);
  await expect(page.getByTestId('feedback-wrong')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('התשובה הנכונה:');
  expect(stripIsolates(await page.getByTestId('feedback-line').textContent())).toBe(STUB_GAP);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
