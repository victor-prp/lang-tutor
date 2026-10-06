import { expect, test, type Locator, type Page } from '@playwright/test';

import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { clearGemini } from './support/mockServer';
import { createLearner, logIn } from './support/users';

test.setTimeout(120_000);

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

// Not in the seed and in no other spec, so the first lookup reaches MockServer
// and is stored. Later tests in the run are served the same content from the
// e2e database.
const GATTO = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'gatto',
      part_of_speech: 'noun',
      senses: [
        { translation: 'חתול', example: { source: 'Il gatto dorme.', target: 'החתול ישן.' }, sense_code: 'cat' },
      ],
    },
  ],
};

const HATUL = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'חתול',
      part_of_speech: 'noun',
      senses: [
        { translation: 'gatto', example: { source: 'החתול ישן.', target: 'Il gatto dorme.' }, sense_code: 'cat' },
      ],
    },
  ],
};

type Utterance = { text: string; lang: string };

/**
 * Chromium in CI has no voices, so before the app loads the page gets a
 * stand-in speechSynthesis. It lists `languages` as voices, records each
 * utterance and ends it at once. expo-speech's own web module still runs, so
 * everything is real except the sound.
 */
async function withVoices(page: Page, languages: string[]) {
  await page.addInitScript((langs: string[]) => {
    const spoken: { text: string; lang: string }[] = [];
    const voices = langs.map((lang) => ({
      lang,
      name: `fake ${lang}`,
      voiceURI: `fake-${lang}`,
      default: false,
      localService: true,
    }));
    const w = window as unknown as Record<string, unknown>;
    if (typeof w.SpeechSynthesisUtterance === 'undefined') {
      w.SpeechSynthesisUtterance = class {
        text = '';
        lang = '';
        onend: ((event: Event) => void) | null = null;
      };
    }
    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      onvoiceschanged: null,
      getVoices: () => voices,
      speak: (utterance: { text: string; lang: string; onend: ((event: Event) => void) | null }) => {
        spoken.push({ text: utterance.text, lang: utterance.lang });
        setTimeout(() => utterance.onend?.(new Event('end')), 0);
      },
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    w.__spoken = spoken;
  }, languages);
}

const spoken = (page: Page) =>
  page.evaluate(() => (window as unknown as { __spoken: Utterance[] }).__spoken);

/** One tap, exactly one utterance. */
async function tapAndHear(page: Page, button: Locator, utterance: Utterance) {
  const before = (await spoken(page)).length;
  await button.click();
  await expect.poll(async () => (await spoken(page)).slice(before)).toEqual([utterance]);
}

test('a lookup speaks the Italian in both directions, and never the Hebrew', async ({ page, request }) => {
  await withVoices(page, ['it-IT', 'en-US']);
  await createLearner(request, 'e2e_voice_lookup', 'it');
  await logIn(page, 'e2e_voice_lookup');
  await tapUntil(page, 'translate-entry', 'translate-input');

  // it → he: the headword and the Italian half of the example speak.
  await lookUp(page, request, 'gatto', GATTO);
  await expect(page.getByTestId('translate-headword')).toContainText('gatto');
  await tapAndHear(page, page.getByTestId('speak-headword'), { text: 'gatto', lang: 'it-IT' });
  await expect(page.getByTestId('speak-example')).toHaveCount(1);
  await tapAndHear(page, page.getByTestId('speak-example'), { text: 'Il gatto dorme.', lang: 'it-IT' });
  await expect(page.getByTestId('speak-translation')).toHaveCount(0);

  // he → it: no headword (what was typed is Hebrew); the translation and the
  // Italian half of the example speak.
  await page.getByTestId('translate-new-word').click();
  await page.getByTestId('translate-flip').click();
  await lookUp(page, request, 'חתול', HATUL);
  await expect(page.getByTestId('translate-headword')).toHaveCount(0);
  await tapAndHear(page, page.getByTestId('speak-translation'), { text: 'gatto', lang: 'it-IT' });
  await expect(page.getByTestId('speak-example')).toHaveCount(1);
  await tapAndHear(page, page.getByTestId('speak-example'), { text: 'Il gatto dorme.', lang: 'it-IT' });
});

test('a session prompt speaks', async ({ page, request }) => {
  await withVoices(page, ['it-IT']);
  await createLearner(request, 'e2e_voice_session', 'it');
  await logIn(page, 'e2e_voice_session');
  await tapUntil(page, 'start-button', 'progress-label');

  const prompt = (await page.getByTestId('question-prompt').textContent()) ?? '';
  expect(prompt).not.toBe('');
  await tapAndHear(page, page.getByTestId('speak-prompt'), { text: prompt, lang: 'it-IT' });
});

test('a saved word speaks from the list without opening, and from its page', async ({ page, request }) => {
  await withVoices(page, ['it-IT']);
  await createLearner(request, 'e2e_voice_saved', 'it');
  await logIn(page, 'e2e_voice_saved');
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'gatto', GATTO);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save').first());

  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  await tapAndHear(page, page.getByTestId('speak-word'), { text: 'gatto', lang: 'it-IT' });
  // The speaker sits beside the row's button, so the word did not open.
  await expect(page.getByTestId('vocabulary-word')).toBeVisible();
  await expect(page.getByTestId('vocabulary-sense')).toHaveCount(0);

  await page.getByTestId('vocabulary-word').click();
  await tapAndHear(page, page.getByTestId('speak-lemma'), { text: 'gatto', lang: 'it-IT' });
  await tapAndHear(page, page.getByTestId('speak-example'), { text: 'Il gatto dorme.', lang: 'it-IT' });
});

test('without an Italian voice, an Italian learner sees no speaker', async ({ page, request }) => {
  await withVoices(page, ['en-US']);
  await createLearner(request, 'e2e_voice_none', 'it');
  await logIn(page, 'e2e_voice_none');
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'gatto', GATTO);

  // The headword still shows, since a correction is read there; its speaker does not.
  await expect(page.getByTestId('translate-headword')).toContainText('gatto');
  await expect(page.getByTestId('speak-headword')).toHaveCount(0);
  await expect(page.getByTestId('speak-example')).toHaveCount(0);
});
