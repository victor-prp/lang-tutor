import type { JudgedAnswerResponse, MyWordsGoal, MyWordsToday, NextStepResponse, SessionView, VocabularyPage } from '@lang-tutor/core/api';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { expectGeneration } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini, expectGeminiMatching } from './support/mockServer';
import { enrollmentIdOf, readCurrent, readyPathSession } from './support/sessions';
import { FILLED, OUTLINED, expectLabel, lookUpEntries, playSessionRight, saveEntries } from './support/targets';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

// Phase 73 (spec D1, D5-D7). My words' daily goal: the card's line, dots and tiles as the day's
// sessions are played, a My words session's results showing the same and continuing straight into
// the next session, the goal set in הגדרות, and a learner with no words of their own sent to Words
// for me and from there into a first session. On a device with no voice and no microphone, so a new
// word's ladder is the written one (as the target specs).
test.setTimeout(300_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

/** Home's reads of My words' session: home sends one each time it takes focus, and the results
 *  screen one when it opens. */
const currentReads = (diagnostics: { apiRequests: string[] }) =>
  diagnostics.apiRequests.filter((sent) => /^GET \S+\/sessions\/current/.test(sent)).length;

/** Home's My words card. Home stays mounted under results and the session on the web, so the card's
 *  own testIDs are read inside it, and the results screen's inside its block. */
const myWordsCard = (page: Page) => page.getByTestId('home-my-words');

/** The day as `expectToday` reads it: the line (null: no line and no dots, the goal off), what is
 *  beside it, each dot's kind, and the two tiles' numbers (null: no tiles). */
type TodayView = {
  line: string | null;
  side?: string | null;
  dots?: ('done' | 'todo' | 'bonus')[];
  tiles: { newWords: number; movedUp: number } | null;
};

/** The tiles the server's numbers call for: none while both are 0 (spec D5). */
const tilesOf = (today: MyWordsToday): TodayView['tiles'] =>
  today.new_words === 0 && today.moved_up === 0 ? null : { newWords: today.new_words, movedUp: today.moved_up };

/**
 * Phase 73 (spec D5). My words' day where `scope` draws it with the testID `prefix` (home's card or
 * the results block): the line and what is beside it, the dots, what a screen reader says of the
 * two (the line first), and the tiles, each its number and its label.
 */
async function expectToday(scope: Locator, prefix: string, view: TodayView): Promise<void> {
  const goal = scope.getByTestId(`${prefix}-goal`);
  if (view.line === null) {
    await expect(goal).toHaveCount(0);
    await expect(scope.locator(`[data-testid^="${prefix}-dot-"]`)).toHaveCount(0);
  } else {
    await expectLabel(scope.getByTestId(`${prefix}-line`), view.line);
    const side = scope.getByTestId(`${prefix}-side`);
    if (view.side == null) await expect(side).toHaveCount(0);
    else await expectLabel(side, view.side);
    const dot = `${prefix}-dot-`;
    const kinds = () =>
      scope.locator(`[data-testid^="${dot}"]`).evaluateAll((dots, at) => dots.map((one) => one.getAttribute('data-testid')!.slice(at.length)), dot);
    await expect.poll(kinds).toEqual(view.dots ?? []);
    await expect.poll(async () => stripIsolates(await goal.getAttribute('aria-label')).startsWith(`${view.line}, `)).toBe(true);
  }
  const newTile = scope.getByTestId(`${prefix}-tile-new`);
  const upTile = scope.getByTestId(`${prefix}-tile-up`);
  if (view.tiles === null) {
    await expect(newTile).toHaveCount(0);
    await expect(upTile).toHaveCount(0);
  } else {
    const { newWords, movedUp } = view.tiles;
    await expectLabel(newTile, `${newWords}${newWords === 1 ? 'מילה חדשה היום' : 'מילים חדשות היום'}`);
    await expectLabel(upTile, `${movedUp}${movedUp === 1 ? 'עלתה רמה היום' : 'עלו רמה היום'}`);
  }
}

/** The main path's day as the server reads it now. */
async function readToday(request: APIRequestContext, enrollmentId: string): Promise<MyWordsToday> {
  const { today } = await readCurrent(request, enrollmentId);
  expect(today, 'the main path read has no today').toBeDefined();
  return today!;
}

/** Back to בית through another tab, so home takes focus and reads My words again. */
async function refocusHome(page: Page): Promise<void> {
  await page.getByTestId('settings-tab').click();
  await expect(page.getByTestId('settings-my-words-goal')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await expect(myWordsCard(page)).toBeVisible();
}

/**
 * Answers every card of a ready session right over the API, from where it stands, as the app would
 * with no help. Past the day's first session a session is two new words' ladders and, in the slots
 * they leave, words already answered today (choose.ts' third pass), asked by their memory: a typed
 * meaning is answered with the saved meaning, which the rule accepts. A card no device of this spec
 * can be asked (listening, speaking), or a sentence the judge reads, fails the spec.
 */
async function answerAllRight(request: APIRequestContext, sessionId: string): Promise<void> {
  const res = await request.get(`${API_URL}/api/sessions/${sessionId}`);
  expect(res.ok(), await res.text()).toBe(true);
  let question = ((await res.json()) as SessionView).question;
  while (question) {
    let data: object;
    // The server judges a typed meaning on a route of its own (sessions.ts' judged-answer).
    let route = 'next-step';
    if (question.type === 'meet') data = { question_id: question.id, seen: true };
    else if (
      question.type === 'multiple_choice' ||
      question.type === 'reverse_choice' ||
      question.type === 'new_meaning' ||
      question.type === 'cloze_choice'
    )
      data = { question_id: question.id, option_index: question.correct_option };
    else if (question.type === 'letter_tiles' || question.type === 'typed_translation' || question.type === 'cloze_typed')
      data = { question_id: question.id, text: question.answer, helped: false };
    else if (question.type === 'typed_meaning') {
      data = { question_id: question.id, text: question.meaning };
      route = 'judged-answer';
    } else throw new Error(`no way to answer a ${question.type} card right over the API`);
    const answered = await request.post(`${API_URL}/api/sessions/${sessionId}/${route}`, { data });
    expect(answered.ok(), await answered.text()).toBe(true);
    const body = (await answered.json()) as NextStepResponse | JudgedAnswerResponse;
    if ('verdict' in body) expect(body.verdict, `${question.type} ${JSON.stringify(question)}`).toBe('exact');
    const next = 'next' in body ? body.next : body;
    expect(next.complete || next.pending_retry === null, `${question.type} was not answered right: ${JSON.stringify(next)}`).toBe(true);
    question = next.complete ? null : next.question;
  }
}

/** Plays the main path's next session right over the API, once it is ready. */
async function playNextOverApi(request: APIRequestContext, enrollmentId: string): Promise<void> {
  await answerAllRight(request, await readyPathSession(request, enrollmentId));
}

/** A learner with every BOARD_WORD of their own and none met: two a session, five sessions of new
 *  words. The generation is stubbed for every session the day makes. */
async function learnerWithWords(page: Page, request: APIRequestContext, username: string): Promise<string> {
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  const entries = await lookUpEntries(page.request, enrollmentId, BOARD_WORDS);
  await expectGeneration(request);
  await saveEntries(page.request, enrollmentId, entries.flat());
  return enrollmentId;
}

test('the card counts the day’s sessions to the goal and past it, and results continue straight into the next session', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const enrollmentId = await learnerWithWords(page, request, 'e2e_goal_day');
  // Saved words and no session: the card's first session is the list's, never the seed, and home
  // makes it on opening.
  await openApp(page);
  const card = myWordsCard(page);
  const today = 'home-my-words-today';

  // 1. Before the day's first session: the goal and how long it takes, three dots to do, no tiles.
  const start: TodayView = { line: 'היעד של היום: 3 תרגולים', side: 'כ-15 דקות', dots: ['todo', 'todo', 'todo'], tiles: null };
  await expectToday(card, today, start);
  await expectLabel(card.getByTestId('start-button'), 'לתרגל עכשיו');
  expect((await readCurrent(page.request, enrollmentId)).next_source, report()).toBe('list');

  // 2. One session played: two to go, and the tiles show what it did.
  await playNextOverApi(page.request, enrollmentId);
  const afterOne = await readToday(page.request, enrollmentId);
  expect(afterOne, report()).toMatchObject({ goal: 3, sessions_done: 1, new_words: 2 });
  await refocusHome(page);
  await expectToday(card, today, {
    line: 'כל הכבוד! עוד 2 תרגולים להיום',
    dots: ['done', 'todo', 'todo'],
    tiles: tilesOf(afterOne),
  });

  // 3. Two played: one to go.
  await playNextOverApi(page.request, enrollmentId);
  const afterTwo = await readToday(page.request, enrollmentId);
  expect(afterTwo, report()).toMatchObject({ sessions_done: 2, new_words: 4 });
  await refocusHome(page);
  await expectToday(card, today, {
    line: 'כל הכבוד! עוד תרגול אחד להיום',
    dots: ['done', 'done', 'todo'],
    tiles: tilesOf(afterTwo),
  });

  // 4. The third on screen: its results show the day met, under a title of their own.
  await readyPathSession(page.request, enrollmentId);
  await refocusHome(page);
  await tapUntil(page, 'start-button', 'progress-label');
  await playSessionRight(page, request, BOARD_WORDS);
  const block = page.getByTestId('results-my-words');
  await expect(block, report()).toBeVisible();
  await expect(block).toContainText('המילים שלי · היום');
  const met = await readToday(page.request, enrollmentId);
  expect(met, report()).toMatchObject({ sessions_done: 3, new_words: 6 });
  const metView: TodayView = { line: 'כל הכבוד! עשית 3 תרגולים היום', dots: ['done', 'done', 'done'], tiles: tilesOf(met) };
  await expectToday(block, 'results-my-words-today', metView);
  const next = page.getByTestId('results-continue');
  await expect(page.getByTestId('results-next-session')).toHaveCount(0);

  // 5. Continue, past the goal too: the next session's first card, with no read of My words between
  // the press and the card (the results screen made its own when it opened), so home never took
  // focus on the way.
  const opened = await readyPathSession(page.request, enrollmentId);
  await expectLabel(next, 'להמשיך לתרגל');
  await expect(next).toBeEnabled();
  await expect(next).toHaveCSS('background-color', FILLED);
  const reads = currentReads(diagnostics);
  await tapUntil(page, 'results-continue', 'progress-label');
  await expect(page.getByTestId('progress-label')).toHaveText(/^\D*1\s*\/\s*\d+/);
  await expect(page.getByTestId('results-score')).toHaveCount(0);
  expect(currentReads(diagnostics), report()).toBe(reads);

  // 6. Back from it is home, where the card says what results said, and offers more, pale.
  await page.getByTestId('session-back').click();
  await expect(page.getByTestId('progress-label')).toBeHidden();
  await expectToday(card, today, metView);
  const more = card.getByTestId('start-button');
  await expectLabel(more, 'לתרגל עוד');
  await expect(more).toHaveCSS('background-color', OUTLINED);

  // 7. The session continue opened, the stock, played to its end: a bonus dot past the goal's three.
  const { current } = await readCurrent(page.request, enrollmentId);
  expect(current, report()).toMatchObject({ session_id: opened, status: 'ready' });
  await answerAllRight(page.request, opened);
  const bonus = await readToday(page.request, enrollmentId);
  expect(bonus, report()).toMatchObject({ sessions_done: 4, new_words: 8 });
  await refocusHome(page);
  await expectToday(card, today, {
    line: 'כל הכבוד! עשית 4 תרגולים היום',
    dots: ['done', 'done', 'done', 'bonus'],
    tiles: tilesOf(bonus),
  });
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

/** The goal as the server stores it. */
async function readGoal(request: APIRequestContext, enrollmentId: string): Promise<MyWordsGoal> {
  const res = await request.get(`${API_URL}/api/enrollments/${enrollmentId}/my-words-goal`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as MyWordsGoal;
}

/** הגדרות → יעד יומי, its screen read. */
async function openGoal(page: Page): Promise<void> {
  await page.getByTestId('settings-tab').click();
  await page.getByTestId('settings-my-words-goal').click();
  await expect(page.getByText('יעד יומי · רוסית')).toBeVisible();
}

/** From the goal screen back to בית, which reads My words again as it takes focus. */
async function goalToHome(page: Page): Promise<void> {
  await page.getByTestId('my-words-goal-back').click();
  await expect(page.getByTestId('settings-my-words-goal')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await expect(myWordsCard(page)).toBeVisible();
}

test('the goal set in הגדרות applies today: lowered to one the card is met, switched off it has no line', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const enrollmentId = await learnerWithWords(page, request, 'e2e_goal_settings');
  // The day's first session, made and played over the API: words of its own, so create answers the
  // list's, not the seed.
  const made = await page.request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } });
  expect(made.ok(), await made.text()).toBe(true);
  expect(((await made.json()) as { source: string }).source).toBe('list');
  await playNextOverApi(page.request, enrollmentId);
  const played = await readToday(page.request, enrollmentId);
  expect(played, report()).toMatchObject({ goal: 3, sessions_done: 1 });
  const tiles = tilesOf(played);
  expect(tiles, report()).not.toBeNull();

  await openApp(page);
  const card = myWordsCard(page);
  const today = 'home-my-words-today';
  await expectToday(card, today, { line: 'כל הכבוד! עוד 2 תרגולים להיום', dots: ['done', 'todo', 'todo'], tiles });

  // 1. The goal screen: on, at the default three; down to one, each step saved as it is made.
  await openGoal(page);
  const on = page.getByTestId('my-words-goal-on').getByRole('switch');
  const value = page.getByTestId('my-words-goal-value');
  await expect(on).toBeChecked();
  await expectLabel(value, '3 תרגולים');
  await page.getByTestId('my-words-goal-less').click();
  await expectLabel(value, '2 תרגולים');
  await page.getByTestId('my-words-goal-less').click();
  await expectLabel(value, 'תרגול אחד');
  await expect(page.getByTestId('my-words-goal-less')).toBeDisabled();
  await expect.poll(() => readGoal(page.request, enrollmentId)).toEqual({ goal: 1 });

  // 2. Home: the one session done meets it, green, and the button offers more, pale.
  await goalToHome(page);
  await expectToday(card, today, { line: 'כל הכבוד! עשית תרגול אחד היום', dots: ['done'], tiles });
  await expectLabel(card.getByTestId('start-button'), 'לתרגל עוד');
  await expect(card.getByTestId('start-button')).toHaveCSS('background-color', OUTLINED);

  // 3. Switched off: no line and no dots, the tiles alone, and the button as it always was.
  await openGoal(page);
  await on.click();
  await expect(on).not.toBeChecked();
  await expect(value).toHaveCount(0);
  await expect.poll(() => readGoal(page.request, enrollmentId)).toEqual({ goal: null });
  await goalToHome(page);
  await expectToday(card, today, { line: null, tiles });
  await expectLabel(card.getByTestId('start-button'), 'לתרגל עכשיו');
  await expect(card.getByTestId('start-button')).toHaveCSS('background-color', FILLED);

  // 4. On again: back to the default three.
  await openGoal(page);
  await on.click();
  await expect(on).toBeChecked();
  await expectLabel(value, '3 תרגולים');
  await expect.poll(() => readGoal(page.request, enrollmentId)).toEqual({ goal: 3 });
  expect(diagnostics.pageErrors, report()).toEqual([]);
});

/** Words for me's round, in order: Russian nouns in no other spec and not in the seed, so each
 *  lookup reaches MockServer (as discover.spec.ts's Italian round). */
const ROUND: [string, string][] = [
  ['чайник', 'קומקום'],
  ['полотенце', 'מגבת'],
  ['ножницы', 'מספריים'],
  ['зеркало', 'מראה'],
  ['лестница', 'סולם'],
  ['утюг', 'מגהץ'],
  ['веник', 'מטאטא'],
];
const KEPT = ROUND.slice(0, 5).map(([word]) => word);

const lookupOf = (lemma: string, translation: string) => ({
  kind: 'word',
  entries: [{ lemma, part_of_speech: 'noun', senses: [{ translation, sense_code: lemma }] }],
});

/** The round, each unknown word's lookup, then the generation for the session saving makes. */
async function stubRun(request: APIRequestContext): Promise<void> {
  await expectGeminiMatching(
    request,
    'propose new words for a learner',
    { words: ROUND.map(([word, hebrew]) => ({ word, part_of_speech: 'noun', hebrew, alternatives: [] })) },
    { once: true, priority: 10 },
  );
  for (const [lemma, hebrew] of ROUND) await expectGeminiMatching(request, `"text":"${lemma}"`, lookupOf(lemma, hebrew));
  await expectGeneration(request);
}

async function savedLemmas(request: APIRequestContext, enrollmentId: string): Promise<string[]> {
  const res = await request.get(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`);
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as VocabularyPage).items.map((word) => word.lemma).sort();
}

test('with no words of their own, the card opens Words for me, and saving there goes straight into a session', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_goal_discover', 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  await openApp(page);
  await stubRun(request);

  // 1. Nothing of their own: the card shows the day's goal, and its button opens Words for me.
  const card = myWordsCard(page);
  await expectToday(card, 'home-my-words-today', {
    line: 'היעד של היום: 3 תרגולים',
    side: 'כ-15 דקות',
    dots: ['todo', 'todo', 'todo'],
    tiles: null,
  });
  await expect(page.getByTestId('save-words-first')).toHaveCount(0);
  await expectLabel(card.getByTestId('start-button'), 'לתרגל עכשיו');
  await tapUntil(page, 'start-button', 'discover-question');
  await expect(page.getByTestId('discover-question')).toHaveText('כמה רוסית אתם כבר יודעים?');
  await page.getByTestId('discover-option-basic').click();
  await page.getByTestId('discover-option-self').click();
  await page.getByTestId('discover-goal-5').click();
  await page.getByTestId('discover-start').click();
  for (const word of KEPT) {
    await expect(page.getByTestId('discover-word')).toHaveText(word);
    await page.getByTestId('discover-dont-know').click();
  }
  const rows = page.getByTestId('photo-import-row');
  await expect(rows).toHaveCount(KEPT.length);
  await expect(page.getByTestId('discover-looking-up')).toHaveCount(0, { timeout: 60_000 });
  expect(await savedLemmas(page.request, enrollmentId)).toEqual([]);

  // 2. Save: straight into the first session, home never shown on the way. Home stays mounted under
  // Words for me on the web, hidden; every frame from the press to the first card is checked.
  const homeShown = () => page.evaluate(() => {
    const home = document.querySelector('[data-testid="home-my-words"]');
    return home instanceof HTMLElement && home.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  });
  expect(await homeShown(), 'home is shown under Words for me').toBe(false);
  await page.evaluate(() => {
    const w = window as unknown as { homeSeen: boolean; watching: boolean };
    w.homeSeen = false;
    w.watching = true;
    const sample = () => {
      const home = document.querySelector('[data-testid="home-my-words"]');
      if (home instanceof HTMLElement && home.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) w.homeSeen = true;
      if (w.watching) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const creates = diagnostics.apiRequests.filter((sent) => /^POST \S+\/api\/sessions$/.test(sent)).length;
  await page.getByTestId('discover-save').click();
  await expect(page.getByTestId('progress-label'), report()).toHaveText(/^\D*1\s*\/\s*\d+/, { timeout: 60_000 });
  const seen = await page.evaluate(() => {
    const w = window as unknown as { homeSeen: boolean; watching: boolean };
    w.watching = false;
    return w.homeSeen;
  });
  expect(seen, `home was shown between the save and the first card\n${report()}`).toBe(false);
  await expect(page.getByTestId('home-photo-saved')).toHaveCount(0);
  // Saving made the main path's session: the list's, of the words just saved.
  expect(diagnostics.apiRequests.filter((sent) => /^POST \S+\/api\/sessions$/.test(sent)).length, report()).toBe(creates + 1);
  expect(await savedLemmas(page.request, enrollmentId)).toEqual([...KEPT].sort());
  const { current } = await readCurrent(page.request, enrollmentId);
  expect(current, report()).toMatchObject({ source: 'list', status: 'ready' });

  // 3. Back from it lands on home.
  await page.getByTestId('session-back').click();
  await expect(page.getByTestId('progress-label')).toBeHidden();
  await expect(card).toBeVisible();
  await expectLabel(card.getByTestId('start-button'), 'לתרגל עכשיו');
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
