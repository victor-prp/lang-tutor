import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import {
  STUB_GAP,
  STUB_GAP_LEMMA,
  STUB_SENTENCE,
  STUB_SENTENCE_HEBREW,
  answerChoice,
  answerTyped,
  expectGeneration,
  readCard,
  rightOption,
  type Card,
} from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { tapUntil } from './support/interactions';
import { seedMemory, type MemorySeed } from './support/memory';
import { clearGemini, expectContext, expectGeminiMatching, expectJudge, userText } from './support/mockServer';
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
/** Phase 34 (spec D8). STUB_GAP's word in STUB_SENTENCE_HEBREW, which a sentence card marks. */
const MARKED = 'קראה';

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

/**
 * Phase 35 (spec D5, D6). The memory that brings out the three sentence cards.
 * No voices and speaking off, so the live dimensions are WR, WP and SP. Five
 * words are due on writing (WP) and one is new:
 * - פרפר, ענן: WP at R 0.50 (S 1, 90 days), level 1: recognition. A choice of
 *   words and a gap to choose both have p = 0.25 + 0.75·√0.50 = 0.78, nearer
 *   0.85 than tiles' 0.71; the tie goes to the type used least, so the first
 *   is reversed and the second a gap to choose.
 * - דרך, סל, צדף: WP at R 0.85 (S 10, 19 days), level 3: recall. A typed
 *   translation, a typed gap and a sentence to translate all have p = 0.85;
 *   the type used least takes each tie, so the three get one each. Five picks
 *   on one dimension pass the cap of four, so the last waits, and still fills
 *   the session: six saved words make six cards.
 * - כפפה: no memory, a choice of meanings.
 * Six picks, so no board. The cards come in the order of their p.
 */
const MEMORY: MemorySeed[] = [
  { gloss: 'פרפר', dimension: 'written_productive', stability: 1, daysAgo: 90, level: 1 },
  { gloss: 'ענן', dimension: 'written_productive', stability: 1, daysAgo: 90, level: 1 },
  { gloss: 'דרך', dimension: 'written_productive', stability: 10, daysAgo: 19, level: 3 },
  { gloss: 'סל', dimension: 'written_productive', stability: 10, daysAgo: 19, level: 3 },
  { gloss: 'צדף', dimension: 'written_productive', stability: 10, daysAgo: 19, level: 3 },
];

/** Six saved words, their memory seeded, and a list session started. */
async function reachSentenceSession(page: Page, request: APIRequestContext, username: string) {
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  await saveSixWords(page.request);
  await seedMemory(username, MEMORY);

  await clearGemini(request);
  await expectGeneration(request);
  // Phase 34 (spec D8). The context call names the practised word in a sentence
  // card's Hebrew, the stub sentence's קראה, which the card marks. Asked of
  // every position, since the order is the cards' p: a bare-word card given
  // no sentence falls back on its saved example, as by default.
  await expectContext(
    request,
    [1, 2, 3, 4, 5, 6].map((position) => ({ key: `q${position}`, sentence_word: MARKED })),
  );
  // Past a skipped seed the home screen offers create, not start, so openApp's default landing does not fit.
  await openApp(page, 'create-button');
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');
}

/** Gets past a card this spec is not about: a choice answered right, a typed
 *  card by its saved form, and a sentence to translate by showing the answer. */
async function pass(page: Page, card: Card) {
  if (card.kind === 'choice' || card.kind === 'reverse' || card.kind === 'cloze-choice') await answerChoice(page, card, true);
  else if (card.kind === 'typed') await answerTyped(page, FORM_OF[card.prompt]);
  else await page.getByTestId('typed-show-answer').click();
  await page.getByTestId('continue-button').click();
}

test('the sentence cards: a gap to choose, a gap to type, a sentence to translate', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await reachSentenceSession(page, request, 'e2e_sentences_ru');

  const kinds: string[] = [];
  for (let position = 1; position <= 6; position++) {
    const card = await readCard(page, position, 6);
    kinds.push(card.kind);
    if (card.kind === 'cloze-choice') {
      // The saved example with its word blanked; no Hebrew until it is answered.
      await expect(page.getByText('איזו מילה חסרה?')).toBeVisible();
      const blanked = stripIsolates(await page.getByTestId('sentence-gap').textContent());
      expect(blanked).toContain('_____');
      expect(FORMS.some((form) => blanked.toLowerCase().includes(form)), blanked).toBe(false);
      await expect(page.getByTestId('sentence-translation')).toHaveCount(0);
      // The right option is the text at the gap, so a sentence-initial word keeps its capital.
      expect(card.options.filter((text) => FORMS.includes(text.toLowerCase()))).toHaveLength(1);
      const right = rightOption(card);
      expect(FORMS).toContain(right.toLowerCase());
      await answerChoice(page, card, true);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await expect(page.getByTestId('sentence-translation')).toHaveText(/\p{Script=Hebrew}/u);
      await expect(page.getByTestId('sentence-gap')).toContainText(right);
      await page.getByTestId('continue-button').click();
    } else if (card.kind === 'cloze-typed') {
      // A new sentence, its Hebrew always shown. Its gap is inflected, so the
      // lemma is a wrong answer and the form the right one.
      await expect(page.getByText('השלימו את המילה החסרה ברוסית')).toBeVisible();
      expect(stripIsolates(await page.getByTestId('sentence-gap').textContent())).toBe('Вчера она _____ эту книгу');
      await expect(page.getByTestId('sentence-translation')).toBeVisible();
      // Phase 34 (spec D8): the Hebrew names the word the gap wants.
      await expect(page.getByTestId('sentence-translation-mark')).toHaveText(MARKED);
      await answerTyped(page, STUB_GAP);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await expect(page.getByTestId('feedback-title')).toHaveText('נכון!');
      await page.getByTestId('continue-button').click();
    } else if (card.kind === 'translate') {
      // Translate the Hebrew sentence; a different order is the judge's to accept.
      await expect(page.getByText('תרגמו לרוסית')).toBeVisible();
      // Phase 34 (spec D8): the sentence marks the practised word.
      await expect(page.getByTestId('sentence-translation')).toHaveText(STUB_SENTENCE_HEBREW);
      await expect(page.getByTestId('sentence-translation-mark')).toHaveText(MARKED);
      await expect(page.getByTestId('translation-reference')).toHaveCount(0);
      await expectJudge(request, 'right');
      await answerTyped(page, 'Она прочитала эту книгу вчера');
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await expect(page.getByTestId('feedback-title')).toHaveText('נכון!');
      await expect(page.getByText('תרגום לדוגמה:')).toBeVisible();
      expect(stripIsolates(await page.getByTestId('translation-reference').textContent())).toBe(STUB_SENTENCE);
      await page.getByTestId('continue-button').click();
    } else {
      await pass(page, card);
    }
  }
  expect(kinds.sort()).toEqual(['choice', 'cloze-choice', 'cloze-typed', 'reverse', 'translate', 'typed']);

  await expect(page.getByTestId('results-score')).toBeVisible();
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('a typed gap refuses the lemma of its inflected word', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await reachSentenceSession(page, request, 'e2e_sentences_lemma_ru');

  // Every card before the typed gap passed, whatever its type.
  for (let position = 1; ; position++) {
    expect(position, 'the session asked no typed gap').toBeLessThanOrEqual(6);
    const card = await readCard(page, position, 6);
    if (card.kind === 'cloze-typed') break;
    await pass(page, card);
  }
  await answerTyped(page, STUB_GAP_LEMMA);
  await expect(page.getByTestId('feedback-wrong')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('התשובה הנכונה:');
  expect(stripIsolates(await page.getByTestId('feedback-line').textContent())).toBe(STUB_GAP);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
