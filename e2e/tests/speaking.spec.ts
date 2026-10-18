import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerMeaning, answerTyped, buildTiles, expectGeneration, readCard, speak, type Card, type CardKind } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { seedMemory, seededR, type MemorySeed } from './support/memory';
import { clearGemini, expectGeminiMatching, expectSoundAlike, expectTranscription, userText } from './support/mockServer';
import { continueMeet } from './support/sessions';
import { stripIsolates } from './support/text';
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

// Phase 54. Two cards for the two seeded words, and a ladder for each of the two new
// ones. Phase 55 (spec D2): this session can speak, so a ladder is six: met, read
// aloud and built from tiles, then asked three ways.
const CARDS = 14;

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
 * - подушка, зонтик: no memory, new words: a ladder each (phase 54), met first and
 *   then asked as a choice of meanings, a choice of words and a typed translation.
 *   Phase 55 (spec D2, D3): each read aloud and built from tiles once met, those
 *   three back to back.
 */
const FIRST: MemorySeed[] = [
  { gloss: 'מרגנית', dimension: 'spoken_productive', stability: 1, daysAgo: 90, level: 1 },
  { gloss: 'צב', dimension: 'spoken_productive', stability: 10, daysAgo: 19, level: 3 },
];

/**
 * The "can't speak now" session, for a learner of its own: a second session the
 * same day would bring back what the first met or missed (phase 37 D1). The read
 * aloud comes before say the translation, the higher p first (spec D6):
 * - ромашка: SK at R 0.74 (S 10, 62 days), level 1: below RUNG_R, so recognition,
 *   a read aloud, p = √0.74 = 0.86.
 * - черепаха: SK at R 0.79 (S 10, 38 days), level 4: say the translation, p = 0.79.
 * - подушка, зонтик: no memory, new words: a ladder each (phase 54), whose cards
 *   the plan spreads through the session (spec D5). Phase 55 (spec D3): each
 *   opens met, read aloud and built from tiles, so the session's first read
 *   aloud is the first ladder's, right after its meet card.
 */
const CANT_SPEAK: MemorySeed[] = [
  { gloss: 'מרגנית', dimension: 'spoken_productive', stability: 10, daysAgo: 62, level: 1 },
  { gloss: 'צב', dimension: 'spoken_productive', stability: 10, daysAgo: 38, level: 4 },
];

/** Gets past a card this spec is not about: a meet card tapped through, a typed
 *  meaning by the saved meaning, which is judged by rule, a typed translation and
 *  a tiles card by its word, and a choice answered right. */
async function pass(page: Page, card: Card) {
  if (card.kind === 'meet') return continueMeet(page);
  if (card.kind === 'meaning') await answerMeaning(page, MEANING_OF[card.prompt]);
  else if (card.kind === 'typed') await answerTyped(page, FORM_OF[card.prompt]);
  else if (card.kind === 'tiles') await buildTiles(page, FORM_OF[card.prompt]);
  else await answerChoice(page, card, true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();
}

/** Phase 55. The next card on screen after `after`. With speaking off a read
 *  aloud is passed unseen (phase 25 D8), and a ladder's read aloud follows its
 *  meet card (spec D3), so the counter can step over a position, which the
 *  caller checks (review M4). */
async function nextShown(page: Page, after: number): Promise<{ position: number; card: Card }> {
  const label = page.getByTestId('progress-label');
  const at = async () => Number(/(\d+)\s*\/\s*\d+/.exec(stripIsolates(await label.textContent()))?.[1]);
  let position = 0;
  await expect(async () => {
    const now = await at();
    expect(now).toBeGreaterThan(after);
    // A card passed unseen shows nothing: the card on screen is the one at the
    // same position before and after the check.
    await expect(page.getByTestId('question-prompt')).toBeVisible({ timeout: 1_000 });
    expect(await at()).toBe(now);
    position = now;
  }, `no card shown after position ${after}`).toPass({ timeout: 30_000 });
  return { position, card: await readCard(page, position, CARDS) };
}

test('speaking: read aloud and say the translation', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_speak_ru', 'ru');
  await saveFourWords(page.request);
  await seedMemory('e2e_speak_ru', FIRST);

  // Session 1: a read aloud, say the translation and the two ladders, whose
  // cards are placed by the plan, so each card is answered by its type.
  await clearGemini(request);
  await expectGeneration(request);
  // Phase 43 (spec D7). Home makes the session itself: it lands on the switcher, then offers start.
  await openApp(page, 'enrollment-switcher');
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  const cards: Card[] = [];
  for (let position = 1; position <= CARDS; position++) {
    const card = await readCard(page, position, CARDS);
    cards.push(card);
    if (card.kind === 'read' && card.prompt !== 'ромашка') {
      // Phase 55 (spec D2): a new word's read aloud, heard as its word at once.
      expect(Object.keys(MEANING_OF)).toContain(card.prompt);
      await expectTranscription(request, card.prompt);
      await speak(page);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await page.getByTestId('continue-button').click();
    } else if (card.kind === 'read') {
      // Read aloud: first not understood, then understood. Phase 50: the second
      // is heard as рамашка, which is how ромашка is said (its unstressed о is
      // an а), so it is understood by sound and the banner shows what was heard.
      expect(card.prompt).toBe('ромашка');
      await expectTranscription(request, 'кошка');
      await expectSoundAlike(request, 'кошка', 0.1);
      await expectTranscription(request, 'рамашка');
      await expectSoundAlike(request, 'рамашка', 1);
      await speak(page);
      await expect(page.getByTestId('speak-notice')).toContainText('לא הבנו');
      await expect(page.getByTestId('speak-notice-heard')).toHaveText(/кошка/);
      await expect(page.getByTestId('feedback-correct')).not.toBeVisible();
      await page.getByTestId('speak-try-again').click();
      await speak(page);
      await expect(page.getByTestId('feedback-title')).toHaveText(/נכון! שמענו:/);
      await expect(page.getByTestId('feedback-line')).toContainText('рамашка');
      await page.getByTestId('continue-button').click();
    } else if (card.kind === 'say') {
      // Phase 56 (spec D1, D6, D8). Help first: its first letter, above the
      // microphone. Then said and understood at once: right, with help.
      const form = FORM_OF[card.prompt];
      await expect(page.getByTestId('speak-hint')).toHaveCount(0);
      await expect(page.getByTestId('speak-help')).toContainText('עזרה');
      await page.getByTestId('speak-help').click();
      await expect(page.getByTestId('speak-hint')).toHaveText(`${[...form][0]}…`);
      await expectTranscription(request, form);
      const sent = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/speech'));
      await speak(page);
      expect((await sent).postDataJSON()).toMatchObject({ helped: true });
      await expect(page.getByTestId('feedback-other')).toBeVisible();
      await expect(page.getByTestId('feedback-title')).toHaveText('נכון, עם עזרה');
      await page.getByTestId('continue-button').click();
    } else {
      await pass(page, card);
    }
  }
  const kinds: CardKind[] = cards.map((card) => card.kind);
  expect([...kinds].sort()).toEqual([
    'choice', 'choice', 'meet', 'meet', 'read', 'read', 'read', 'reverse', 'reverse', 'say', 'tiles', 'tiles', 'typed', 'typed',
  ]);
  // Phase 55 (spec D3): each new word's intro stage back to back, its meet card,
  // its read aloud and its tiles.
  for (const [index, card] of cards.entries()) {
    if (card.kind !== 'meet') continue;
    expect(cards[index + 1], kinds.join(', ')).toEqual(expect.objectContaining({ kind: 'read', prompt: card.prompt }));
    expect(cards[index + 2], kinds.join(', ')).toEqual(expect.objectContaining({ kind: 'tiles', prompt: MEANING_OF[card.prompt] }));
  }

  await expect(page.getByText(/דיבור/).first(), report()).toBeVisible();
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

// Phase 56 (spec D5). One help count for the card: letters shown while speaking stay
// shown once "can't speak now" turns say the translation typed, and the typed answer
// says it was helped.
test("speaking: help on say the translation carries over when it turns typed", async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_speak_help_ru', 'ru');
  await saveFourWords(page.request);
  await seedMemory('e2e_speak_help_ru', FIRST);

  await clearGemini(request);
  await expectGeneration(request);
  await openApp(page, 'enrollment-switcher');
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  // Every card before say the translation, a read aloud said as its word.
  let card: Card;
  for (let position = 1; ; position++) {
    expect(position, 'the session asked no say the translation').toBeLessThan(CARDS);
    card = await readCard(page, position, CARDS);
    if (card.kind === 'say') break;
    if (card.kind === 'read') {
      await expectTranscription(request, card.prompt);
      await speak(page);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await page.getByTestId('continue-button').click();
    } else {
      await pass(page, card);
    }
  }
  const form = FORM_OF[card.prompt];
  const two = `${[...form].slice(0, 2).join('')}…`;
  await page.getByTestId('speak-help').click();
  await page.getByTestId('speak-help').click();
  await expect(page.getByTestId('speak-hint')).toHaveText(two);

  // The same card, typed: its two letters still shown, before any press.
  await page.getByTestId('speak-cant-speak').click();
  await expect(page.getByTestId('typed-input')).toBeVisible();
  await expect(page.getByTestId('typed-hint')).toHaveText(two);
  await page.getByTestId('typed-help').click();
  await expect(page.getByTestId('typed-hint')).toHaveText(`${[...form].slice(0, 3).join('')}…`);
  const sent = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/next-step'));
  await answerTyped(page, form);
  expect((await sent).postDataJSON()).toMatchObject({ text: form, helped: true });
  await expect(page.getByTestId('feedback-other')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון, עם עזרה');

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test("speaking: can't speak now passes the read aloud, and say the translation turns typed", async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  // The seeds sit in the bands the session needs (phase 37 D2).
  expect(seededR(CANT_SPEAK[0])).toBeLessThan(0.75);
  expect(seededR(CANT_SPEAK[1])).toBeGreaterThanOrEqual(0.75);
  expect(Math.sqrt(seededR(CANT_SPEAK[0]))).toBeGreaterThan(seededR(CANT_SPEAK[1]));
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_speak_cant_ru', 'ru');
  await saveFourWords(page.request);
  await seedMemory('e2e_speak_cant_ru', CANT_SPEAK);

  // Review M4. Each card the server sends, by position: what a position the counter
  // stepped over held. Read once the session is played.
  const served: Promise<[number, string] | null>[] = [];
  page.on('response', (response) => {
    if (response.request().method() !== 'POST' || !/\/next-step$/.test(response.url())) return;
    served.push(
      response
        .json()
        .then((body: { question?: { type: string }; position?: { position: number } }) =>
          body.question && body.position ? ([body.position.position, body.question.type] as [number, string]) : null,
        )
        .catch(() => null),
    );
  });

  await clearGemini(request);
  await expectGeneration(request);
  // Phase 43 (spec D7). Home makes the session itself: it lands on the switcher, then offers start.
  await openApp(page, 'enrollment-switcher');
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  let position = 1;
  for (; ; position++) {
    expect(position, 'the session asked no read aloud').toBeLessThan(CARDS);
    const card = await readCard(page, position, CARDS);
    if (card.kind === 'read') break;
    expect(card.kind, `position ${position}`).not.toBe('say');
    await pass(page, card);
  }
  // "Can't speak now" passes the card unseen (spec D8 of phase 25): the next
  // card is up, and no banner or Continue came between. Phase 55: whichever
  // read aloud it is, a new word's or ромашка's, speaking is off from here.
  await page.getByTestId('speak-cant-speak').click();
  let shown = await nextShown(page, position);
  // Review M4: the card it passed is the one gone, and the next is up: none stepped over.
  // The first read aloud is the first ladder's, so the next card is its tiles.
  expect(shown.position, 'the card after the one passed').toBe(position + 1);
  await expect(page.getByTestId('feedback-title')).toHaveCount(0);
  await expect(page.getByTestId('continue-button')).toHaveCount(0);

  // Say the translation renders as the typed card from now on: черепаха's card
  // is the one typed card that is not a new word's translation (phase 54). Every
  // read aloud left is passed unseen, so none shows.
  const stepped: number[] = [];
  for (;;) {
    const { card } = shown;
    expect(card.kind, `position ${shown.position}`).not.toBe('say');
    expect(card.kind, `position ${shown.position}`).not.toBe('read');
    if (card.kind === 'typed' && card.prompt === 'צב') {
      await answerTyped(page, FORM_OF[card.prompt]);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await page.getByTestId('continue-button').click();
      break;
    }
    await pass(page, card);
    const before = shown.position;
    shown = await nextShown(page, before);
    for (let at = before + 1; at < shown.position; at++) stepped.push(at);
  }
  // Review M4. Exactly the read alouds left before черепаха's card were stepped over,
  // passed unseen: the second ladder's and ромашка's. A real card skipped would be one more.
  const types = new Map((await Promise.all(served)).filter((entry) => entry !== null));
  expect(stepped.map((at) => types.get(at)), `stepped over ${stepped.join(', ')}`).toEqual(['read_aloud', 'read_aloud']);
  position = shown.position;
  // The last card ends on the results; an earlier one is skipped back home. The results
  // keep home's start button mounted behind them, so each ending is checked on its own.
  if (position < CARDS) {
    await page.getByTestId('session-skip').click();
    // Phase 43 (spec D2, D3): the next session in stock, built while this one was played.
    await expect(page.getByTestId('start-button').or(page.getByTestId('preparing-label'))).toBeVisible();
  } else {
    await expect(page.getByTestId('results-score')).toBeVisible();
  }

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
