import { expect, type Page } from '@playwright/test';

export type Utterance = { text: string; lang: string };

/**
 * Chromium in CI has no voices, so before the app loads the page gets a
 * stand-in speechSynthesis. It lists `languages` as voices, records each
 * utterance and ends it at once. expo-speech's own web module still runs, so
 * everything is real except the sound.
 */
export async function withVoices(page: Page, languages: string[]) {
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

export const spoken = (page: Page) =>
  page.evaluate(() => (window as unknown as { __spoken: Utterance[] }).__spoken);

/** Phase 24. The first utterance after the first `before`, once there is one. */
export async function spokenAfter(page: Page, before: number): Promise<Utterance> {
  await expect.poll(async () => (await spoken(page)).length).toBeGreaterThan(before);
  return (await spoken(page))[before];
}
