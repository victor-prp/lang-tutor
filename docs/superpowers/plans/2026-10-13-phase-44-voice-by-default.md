# Phase 44 — Voice by default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session card reads its target-language text aloud when it appears, unless hearing it gives the answer away, and a silent card reads the right answer once its answer is checked.

**Architecture:** App only. A pure module `apps/mobile/src/cardVoice.ts` says what each card type says (`cardVoice`) and when (`nextCue`); a thin hook `useCardVoice` runs it on the session screen and calls the speaker, which gains `say` and `stop`. `ListenPrompt` loses its own auto-play, the microphone stops speech before recording, and the matching board says a word when it is tapped.

**Tech Stack:** Expo 57 / React Native, TypeScript, jest-expo (unit), Playwright (e2e, web build with a fake `speechSynthesis`).

**Spec:** `docs/superpowers/specs/2026-10-13-lang-tutor-phase-44-voice-by-default-design.md`

## Global Constraints

- Worktree: `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default`. Every command starts with `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default && …`. Never `cd` into, read from or write to `/Users/victorprp/git/lang-tutor` itself (the main checkout).
- All nine lanes are taken: this worktree has no `.lane`, so `npm run e2e`, `npm run test:integration` and anything through `scripts/lane-env.sh` refuse to run. Do not create `.lane` and do not run `lane:down`/`lane:clean`. Unit tests, typecheck and `./scripts/check-adrs.sh` run fine; e2e is verified in CI.
- No server, wire, prompt or `packages/core` change; no `API_LEVEL` bump (spec R10).
- Hebrew is never voiced: the speaker already refuses it (`VOICE_TAGS` has no `he`). Do not add a language check of your own.
- Never put a wait for the voices in front of a tap (phase 43 R9): cues play when the voices arrive, nothing is held for them.
- Comments follow the file's style: a short "Phase 44 (spec Dn)" note where behaviour is decided, no more.
- Unit tests: `cd apps/mobile && npx jest <file>`. Typecheck: `cd apps/mobile && npx tsc --noEmit`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Message style: `feat(mobile): …`, `test(e2e): …`.

## Review Focus

1. A card whose arrival text equals the text still playing (the previous card's answer is the next card's word) must still speak: `say` never toggles off. Pinned in Task 1.
2. Voices that load after the card appeared: the arrival cue plays once when they arrive, and not again on the banner. Pinned in Task 2.
3. A second-try hold (phase 42) shows no banner: the answer must not play until the final banner. Pinned in Task 2.
4. React's development double-run of effects: the same input twice must give no second cue. Pinned in Task 2.
5. A read-aloud card's arrival cue must not be recorded: speech stops before the recorder starts. No component tests exist; the reviewer checks Task 3's `onMic` by reading it.

---

### Task 1: The speaker's `say` and `stop`

**Files:**
- Modify: `apps/mobile/src/speech.ts` (inside `createSpeaker`, lines 100-152)
- Modify: `apps/mobile/src/hooks/useSpeech.tsx` (`SpeechValue` and `useSpeech`)
- Test: `apps/mobile/src/speech.test.ts` (inside `describe('createSpeaker', …)`; reuse `started()`, `fakeEngine`, `flush`)

**Interfaces:**
- Produces: `Speaker.say(text: string, language: string): Promise<void>`, `Speaker.stop(): Promise<void>`; `SpeechValue.say`, `SpeechValue.stop` with the same signatures. `toggle` keeps its signature and behaviour.

- [ ] **Step 1: Write the failing tests** (add inside `describe('createSpeaker', …)`)

```ts
  it('say stops whatever is speaking, then speaks with the tag', async () => {
    const { speaker, calls, spoken } = await started();
    await speaker.say('casa', 'it');
    expect(calls).toEqual(['stop', 'speak casa']);
    expect(spoken[0].options.language).toBe('it-IT');
    expect(speaker.snapshot().playing).toEqual({ text: 'casa', language: 'it' });
  });

  it('say on the text that is playing speaks it again, never stops it', async () => {
    const { speaker, calls } = await started();
    await speaker.say('casa', 'it');
    await speaker.say('casa', 'it');
    expect(calls).toEqual(['stop', 'speak casa', 'stop', 'speak casa']);
    expect(speaker.snapshot().playing).toEqual({ text: 'casa', language: 'it' });
  });

  it('say in a language with no voice does nothing', async () => {
    const { speaker, calls } = await started();
    await speaker.say('дом', 'ru');
    expect(calls).toEqual([]);
    expect(speaker.snapshot().playing).toBeNull();
  });

  it('stop ends the utterance and clears playing', async () => {
    const { speaker, calls, spoken } = await started();
    await speaker.say('casa', 'it');
    await speaker.stop();
    expect(calls).toEqual(['stop', 'speak casa', 'stop']);
    expect(speaker.snapshot().playing).toBeNull();
    // The stopped utterance's late callback changes nothing.
    spoken[0].options.onStopped();
    expect(speaker.snapshot().playing).toBeNull();
  });

  it('stop with nothing playing calls nothing', async () => {
    const { speaker, calls } = await started();
    await speaker.stop();
    expect(calls).toEqual([]);
  });

  it('stop while a say waits on the engine keeps that say from speaking', async () => {
    const fake = fakeEngine();
    const { speaker, calls } = await started(fake);
    fake.holdStops();
    const pending = speaker.say('casa', 'it');
    const stopping = speaker.stop();
    await fake.releaseStops();
    await Promise.all([pending, stopping]);
    expect(calls.filter((call) => call.startsWith('speak'))).toEqual([]);
    expect(speaker.snapshot().playing).toBeNull();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default/apps/mobile && npx jest src/speech.test.ts`
Expected: FAIL with `speaker.say is not a function`.

- [ ] **Step 3: Implement.** In `createSpeaker`, replace the `toggle` property with these three, keeping `start`, `snapshot` and `subscribe` as they are:

```ts
  /** Phase 44 (spec D3). Speaks `text` after stopping whatever was speaking,
   *  and never toggles off: a card's cue may repeat the text still playing. */
  async function say(text: string, language: string): Promise<void> {
    const tag = snapshot.tags.get(language);
    if (!tag) return;
    const mine = ++ticket;
    update({ playing: { text, language } });
    await engine.stop().catch(() => undefined);
    // A later say, tap or stop took over while the engine stopped.
    if (mine !== ticket) return;
    const end = () => {
      if (mine === ticket) update({ playing: null });
    };
    engine.speak(text, { language: tag, rate: 1, onDone: end, onStopped: end, onError: end });
  }

  /** Phase 44 (spec D3). Ends any utterance, and any say still waiting to speak. */
  async function stop(): Promise<void> {
    ++ticket;
    if (!snapshot.playing) return;
    update({ playing: null });
    await engine.stop().catch(() => undefined);
  }
```

Declare `say` and `stop` inside `createSpeaker` above its `return`, then in the returned object:

```ts
    say,
    stop,
    /**
     * Speaks `text` after stopping whatever was speaking; nothing is queued. A
     * tap on the text that is speaking stops it. A language without a voice
     * does nothing.
     */
    toggle: (text: string, language: string): Promise<void> => {
      const wasPlaying = snapshot.playing?.text === text && snapshot.playing.language === language;
      return wasPlaying ? stop() : say(text, language);
    },
```

In `hooks/useSpeech.tsx`, add to `SpeechValue`:

```ts
  /** Phase 44. Speaks, never toggling off. */
  say: (text: string, language: string) => Promise<void>;
  stop: () => Promise<void>;
```

and to the object `useSpeech` returns: `say: speaker.say, stop: speaker.stop,`.

- [ ] **Step 4: Run the whole speaker suite** (the old `toggle` tests must still pass unchanged)

Run: `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default/apps/mobile && npx jest src/speech.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default && git add apps/mobile/src/speech.ts apps/mobile/src/speech.test.ts apps/mobile/src/hooks/useSpeech.tsx && git commit -m "feat(mobile): the speaker can say and stop (phase 44 D3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: What a card says, and when

**Files:**
- Create: `apps/mobile/src/cardVoice.ts`
- Test: `apps/mobile/src/cardVoice.test.ts`

**Interfaces:**
- Produces:
  - `type CardVoice = { arrival: string | null; after: string | null }`
  - `cardVoice(question: Question, options: { speaking: boolean }): CardVoice`
  - `type CueState = { id: string | null; arrived: boolean; answered: boolean }`, `const NO_CUE: CueState`
  - `type CueInput = { id: string; voice: CardVoice; voiced: boolean; banner: boolean }`
  - `type Cue = { kind: 'say'; text: string } | { kind: 'stop' } | null`
  - `nextCue(state: CueState, input: CueInput): { state: CueState; cue: Cue }`

- [ ] **Step 1: Write the failing tests** (`apps/mobile/src/cardVoice.test.ts`)

```ts
import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { cardVoice, nextCue, NO_CUE, type CardVoice, type CueInput, type CueState } from './cardVoice';

// Only the fields cardVoice reads; the rest of each question does not matter here.
const q = (fields: Record<string, unknown>) => fields as unknown as Question;
const sentence = 'Ieri parlavamo per ore.';

const CARDS: Record<Question['type'], Question> = {
  multiple_choice: q({ id: '1', type: 'multiple_choice', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 }),
  new_meaning: q({ id: '2', type: 'new_meaning', question: 'pianta', options: ['צמח', 'מפה'], correct_option: 0 }),
  typed_meaning: q({ id: '3', type: 'typed_meaning', question: 'porta', meaning: 'דלת' }),
  listen_choice: q({ id: '4', type: 'listen_choice', question: 'casa', options: ['בית'], correct_option: 0 }),
  dictation: q({ id: '5', type: 'dictation', question: 'parlo', meaning: 'מדבר' }),
  read_aloud: q({ id: '6', type: 'read_aloud', question: 'gatto', meaning: 'חתול' }),
  reverse_choice: q({ id: '7', type: 'reverse_choice', question: 'בית', options: ['porta', 'casa'], correct_option: 1 }),
  typed_translation: q({ id: '8', type: 'typed_translation', question: 'חלון', answer: 'finestra' }),
  letter_tiles: q({ id: '9', type: 'letter_tiles', question: 'בית', answer: 'casa', tiles: [] }),
  say_translation: q({ id: '10', type: 'say_translation', question: 'כלב', answer: 'cane' }),
  cloze_choice: q({ id: '11', type: 'cloze_choice', sentence, gap: { start: 5, end: 14 }, options: ['parlavamo', 'parlano'], correct_option: 0 }),
  cloze_typed: q({ id: '12', type: 'cloze_typed', sentence, gap: { start: 5, end: 14 }, answer: 'parlavamo' }),
  sentence_translation: q({ id: '13', type: 'sentence_translation', question: 'אתמול דיברנו', sentence, answer: 'parlavamo' }),
  matching: q({ id: '14', type: 'matching', question: 'casa', board: { words: ['casa'] }, options: ['בית'] }),
};

const voiceOf = (type: Question['type']) => cardVoice(CARDS[type], { speaking: true });

describe('cardVoice (spec D1)', () => {
  it.each([
    ['multiple_choice', { arrival: 'casa', after: null }],
    ['new_meaning', { arrival: 'pianta', after: null }],
    ['typed_meaning', { arrival: 'porta', after: null }],
    ['listen_choice', { arrival: 'casa', after: null }],
    ['dictation', { arrival: 'parlo', after: null }],
    ['read_aloud', { arrival: 'gatto', after: null }],
    ['reverse_choice', { arrival: null, after: 'casa' }],
    ['typed_translation', { arrival: null, after: 'finestra' }],
    ['letter_tiles', { arrival: null, after: 'casa' }],
    ['say_translation', { arrival: null, after: 'cane' }],
    ['cloze_choice', { arrival: null, after: sentence }],
    ['cloze_typed', { arrival: null, after: sentence }],
    ['sentence_translation', { arrival: null, after: sentence }],
    ['matching', { arrival: null, after: null }],
  ] as [Question['type'], CardVoice][])('%s', (type, expected) => {
    expect(voiceOf(type)).toEqual(expected);
  });

  it('Done 1: every type but the board makes a sound (the board speaks on tap, D5)', () => {
    for (const type of Object.keys(CARDS) as Question['type'][]) {
      const { arrival, after } = voiceOf(type);
      if (type !== 'matching') expect(arrival ?? after).not.toBeNull();
    }
  });

  it('Done 2: a card whose answer is target-language text is silent on arrival, but for dictation and read aloud', () => {
    const producesTarget: Question['type'][] = [
      'reverse_choice', 'typed_translation', 'letter_tiles', 'say_translation',
      'cloze_choice', 'cloze_typed', 'sentence_translation',
    ];
    for (const type of producesTarget) expect(voiceOf(type).arrival).toBeNull();
  });

  it('R7: no card has both cues', () => {
    for (const type of Object.keys(CARDS) as Question['type'][]) {
      const { arrival, after } = voiceOf(type);
      expect(arrival !== null && after !== null).toBe(false);
    }
  });

  it('a read-aloud card passed unseen, with speaking off, says nothing', () => {
    expect(cardVoice(CARDS.read_aloud, { speaking: false })).toEqual({ arrival: null, after: null });
  });

  it('a say-the-translation card typed, with speaking off, keeps its cue', () => {
    expect(cardVoice(CARDS.say_translation, { speaking: false })).toEqual({ arrival: null, after: 'cane' });
  });
});

describe('nextCue (spec D2)', () => {
  const word: CardVoice = { arrival: 'casa', after: null };
  const typed: CardVoice = { arrival: null, after: 'finestra' };
  const input = (over: Partial<CueInput>): CueInput => ({ id: 'a', voice: word, voiced: true, banner: false, ...over });

  // Runs the inputs in order, as the hook's effect would, and collects the cues.
  function run(inputs: CueInput[], from: CueState = NO_CUE) {
    let state = from;
    return inputs.map((next) => {
      const step = nextCue(state, next);
      state = step.state;
      return step.cue;
    });
  }

  it('a card says its arrival cue once, however often it re-renders', () => {
    expect(run([input({}), input({}), input({})])).toEqual([{ kind: 'say', text: 'casa' }, null, null]);
  });

  it('arrival waits for a voice, then plays once it is there', () => {
    expect(run([input({ voiced: false }), input({ voiced: true })])).toEqual([{ kind: 'stop' }, { kind: 'say', text: 'casa' }]);
  });

  it('voices that arrive after the answer play nothing', () => {
    expect(run([input({ voiced: false }), input({ voiced: false, banner: true }), input({ voiced: true, banner: true })])).toEqual([
      { kind: 'stop' },
      null,
      null,
    ]);
  });

  it('the after cue plays once, when the banner appears', () => {
    const cues = run([input({ voice: typed }), input({ voice: typed, banner: true }), input({ voice: typed, banner: true })]);
    expect(cues).toEqual([{ kind: 'stop' }, { kind: 'say', text: 'finestra' }, null]);
  });

  it('R6: a second-try hold shows no banner and plays nothing; the final banner plays the answer', () => {
    // Answered once (held: no banner), tried again, then the banner.
    const cues = run([input({ voice: typed }), input({ voice: typed }), input({ voice: typed, banner: true })]);
    expect(cues).toEqual([{ kind: 'stop' }, null, { kind: 'say', text: 'finestra' }]);
  });

  it('R7: a card that spoke on arrival says nothing more on the banner', () => {
    expect(run([input({}), input({ banner: true })])).toEqual([{ kind: 'say', text: 'casa' }, null]);
  });

  it('R8: a new card with nothing to say on arrival stops what is playing', () => {
    expect(run([input({ voice: typed }), input({ voice: typed, banner: true }), input({ id: 'b', voice: typed })])).toEqual([
      { kind: 'stop' },
      { kind: 'say', text: 'finestra' },
      { kind: 'stop' },
    ]);
  });

  it('a new card with an arrival cue says it (say stops the old one itself)', () => {
    expect(run([input({ voice: typed, banner: true }), input({ id: 'b' })])).toEqual([
      { kind: 'say', text: 'finestra' },
      { kind: 'say', text: 'casa' },
    ]);
  });

  it('a card with no voice in the language says nothing after the answer', () => {
    expect(run([input({ voice: typed, voiced: false }), input({ voice: typed, voiced: false, banner: true })])).toEqual([
      { kind: 'stop' },
      null,
    ]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default/apps/mobile && npx jest src/cardVoice.test.ts`
Expected: FAIL with `Cannot find module './cardVoice'`.

- [ ] **Step 3: Implement** (`apps/mobile/src/cardVoice.ts`)

```ts
import type { Question } from '@lang-tutor/core/api';
import { rightAnswer } from '@lang-tutor/core/domain';

/**
 * Phase 44 (spec D1). What a session card says by itself, in the language being
 * learned: on arrival, unless hearing it would give the answer away, or else
 * once its answer is checked. Never both (R7). The board says nothing by
 * itself: its words speak when tapped (D5).
 */
export type CardVoice = { arrival: string | null; after: string | null };

const SILENT: CardVoice = { arrival: null, after: null };

export function cardVoice(question: Question, { speaking }: { speaking: boolean }): CardVoice {
  switch (question.type) {
    case 'multiple_choice':
    case 'new_meaning':
    case 'typed_meaning':
    case 'listen_choice':
    case 'dictation':
      return { arrival: question.question, after: null };
    case 'read_aloud':
      // R1: the word is on screen, so hearing it is a model, not the answer.
      // With speaking off the card is passed unseen.
      return speaking ? { arrival: question.question, after: null } : SILENT;
    case 'reverse_choice':
      return { arrival: null, after: rightAnswer(question) };
    case 'typed_translation':
    case 'letter_tiles':
    case 'say_translation':
      return { arrival: null, after: question.answer };
    case 'cloze_choice':
    case 'cloze_typed':
    case 'sentence_translation':
      // R4: the whole sentence, once the gap is answered.
      return { arrival: null, after: question.sentence };
    case 'matching':
      return SILENT;
    default: {
      const unhandled: never = question;
      throw new Error(`unhandled question type: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** What the session screen has already said for the card in front of it. */
export type CueState = { id: string | null; arrived: boolean; answered: boolean };
export const NO_CUE: CueState = { id: null, arrived: false, answered: false };

export type CueInput = {
  id: string;
  voice: CardVoice;
  /** Whether the device has a voice for the language being learned. */
  voiced: boolean;
  /** Whether the answer banner shows: not on a second-try hold, not on a skip. */
  banner: boolean;
};

export type Cue = { kind: 'say'; text: string } | { kind: 'stop' } | null;

/**
 * Phase 44 (spec D2). One step per render of the session screen. The arrival
 * cue plays once per card, as soon as there is a voice and while the card is
 * unanswered; the after cue plays once, when the banner first shows (R5, R6).
 * A new card with nothing to say stops what is still playing (R8). The same
 * input twice gives nothing the second time, so React's development double-run
 * of effects is harmless.
 */
export function nextCue(state: CueState, input: CueInput): { state: CueState; cue: Cue } {
  const fresh = state.id !== input.id;
  const current: CueState = fresh ? { id: input.id, arrived: false, answered: false } : state;

  if (input.banner) {
    if (current.answered) return { state: current, cue: fresh ? { kind: 'stop' } : null };
    const next = { ...current, answered: true };
    const after = !current.arrived && input.voiced ? input.voice.after : null;
    if (after !== null) return { state: next, cue: { kind: 'say', text: after } };
    return { state: next, cue: fresh ? { kind: 'stop' } : null };
  }

  if (!current.arrived && !current.answered && input.voiced && input.voice.arrival !== null) {
    return { state: { ...current, arrived: true }, cue: { kind: 'say', text: input.voice.arrival } };
  }
  return { state: current, cue: fresh ? { kind: 'stop' } : null };
}
```

Note on the test `'a new card with an arrival cue says it'`: its first input is a fresh card with the banner already showing, so the after cue plays at once. That is the first-render-with-banner case (a resumed, answered card); it is fine for it to speak.

- [ ] **Step 4: Run the tests**

Run: `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default/apps/mobile && npx jest src/cardVoice.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. If a test and the implementation disagree, the spec's D2 decides; fix whichever is wrong and say which in the report.

- [ ] **Step 5: Commit**

```bash
cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default && git add apps/mobile/src/cardVoice.ts apps/mobile/src/cardVoice.test.ts && git commit -m "feat(mobile): what a card says, and when (phase 44 D1, D2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire it into the session

**Files:**
- Create: `apps/mobile/src/hooks/useCardVoice.ts`
- Modify: `apps/mobile/src/app/session.tsx` (`SessionScreen`, from line 322; the `matching` case at line 249)
- Modify: `apps/mobile/src/components/ListenPrompt.tsx` (remove the auto-play effect, lines 27-38)
- Modify: `apps/mobile/src/components/SpeakingCardView.tsx` (`onMic`, line 101)
- Modify: `apps/mobile/src/components/MatchingBoardView.tsx` (props and the word buttons' `onPress`)

**Interfaces:**
- Consumes: `cardVoice`, `nextCue`, `NO_CUE`, `CueState` from Task 2; `Speaker.say`, `Speaker.stop` from Task 1; `useSpeaker()` from `@/hooks/useSpeech`.
- Produces: `useCardVoice(question: Question | null, options: { language: string; banner: boolean; speaking: boolean }): void`.

- [ ] **Step 1: The hook** (`apps/mobile/src/hooks/useCardVoice.ts`)

```ts
import type { Question } from '@lang-tutor/core/api';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { cardVoice, nextCue, NO_CUE, type CueState } from '@/cardVoice';
import { useSpeaker } from '@/hooks/useSpeech';

/**
 * Phase 44 (spec D2). Plays the card's cues through the speaker. It subscribes
 * to whether the language has a voice, not to every utterance, so the session
 * screen does not re-render each time something plays. Nothing waits for the
 * voices: a cue plays when they arrive (phase 43 R9).
 */
export function useCardVoice(
  question: Question | null,
  { language, banner, speaking }: { language: string; banner: boolean; speaking: boolean },
): void {
  const speaker = useSpeaker();
  const voiced = useSyncExternalStore(
    speaker.subscribe,
    () => speaker.snapshot().tags.has(language),
    () => false,
  );
  const state = useRef<CueState>(NO_CUE);
  const id = question?.id ?? null;
  const voice = question ? cardVoice(question, { speaking }) : null;
  const arrival = voice?.arrival ?? null;
  const after = voice?.after ?? null;

  useEffect(() => {
    if (id === null) return;
    const step = nextCue(state.current, { id, voice: { arrival, after }, voiced, banner });
    state.current = step.state;
    if (step.cue?.kind === 'say') void speaker.say(step.cue.text, language);
    else if (step.cue?.kind === 'stop') void speaker.stop();
  }, [id, arrival, after, voiced, banner, language, speaker]);
}
```

- [ ] **Step 2: Call it from `SessionScreen`** (`app/session.tsx`). Hooks must run before the early returns, so move the `language` line up and call the hook right after `const skipping = useRef(false);`:

```ts
  // A session is always entered from home, which needs an active enrollment;
  // an empty language only drops the name from the instruction.
  const language = active?.target_language ?? '';
  // Phase 44 (spec D2): the card reads itself aloud.
  useCardVoice(session.question ?? null, {
    language,
    banner: session.answer !== null && !isSkip(session.answer),
    speaking: session.speakingOff === null,
  });
```

Delete the old `language` declaration and its comment further down (keep the `learner` line). Add `import { useCardVoice } from '@/hooks/useCardVoice';` beside the other hook imports. Check the actual types: if `session.answer` is `undefined` rather than `null` when absent, write the banner as `!!session.answer && !isSkip(session.answer)`, which is the exact condition the `FeedbackBanner` render uses at the bottom of the screen. The two must stay the same.

- [ ] **Step 3: `ListenPrompt` loses its auto-play.** Remove the `played` ref and the `useEffect` (lines 27-38) and the now-unused `useEffect, useRef` import. Change the doc comment's first sentence to: `Phase 24 (spec D6). A listening card's prompt. The word is spoken on arrival by the session's card voice (phase 44 D2) and on every tap, and shown only after the answer.` Everything else in the component stays.

- [ ] **Step 4: The microphone stops speech first** (`SpeakingCardView.tsx`). Add `import { useSpeaker } from '@/hooks/useSpeech';`, `const speaker = useSpeaker();` beside `const recorder = useRecorder();`, and in `onMic` make the `try` block start with the stop:

```ts
    try {
      // Phase 44 (spec D4): the card's own voice must not be recorded as the answer.
      await speaker.stop();
      started = await recorder.start();
    } catch {
```

- [ ] **Step 5: The board says a word when tapped** (`MatchingBoardView.tsx`). Add `language: string;` to `Props` (destructure it), `import { useSpeaker } from '@/hooks/useSpeech';`, `const speaker = useSpeaker();` at the top of the component, and change the word button's `onPress`:

```ts
              onPress={() => {
                // Phase 44 (spec D5, R3): the board's target words speak when tapped.
                void speaker.say(word, language);
                setState((current) => tapWord(current, question, index));
              }}
```

The meaning buttons stay silent. In `session.tsx`'s `matching` case pass `language={language}`.

- [ ] **Step 6: Verify**

Run: `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default/apps/mobile && npx tsc --noEmit && npx jest`
Expected: no type errors; every mobile unit test passes.

Then `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default && ./scripts/check-adrs.sh` — expected: prints nothing, exit 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default && git add apps/mobile/src && git commit -m "feat(mobile): a session card reads itself aloud (phase 44 D2, D4, D5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: e2e

e2e cannot run in this worktree (no lane); CI runs it. Write carefully and typecheck: `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default/e2e && npx tsc --noEmit` (if `e2e/package.json` has a `typecheck` script, use that instead).

**Background:** `e2e/tests/support/voices.ts` installs a fake `speechSynthesis` when a spec calls `withVoices(page, [...tags])`. `spoken(page)` returns every utterance so far as `{ text, lang }`; `spokenAfter(page, before)` waits for the utterance at index `before`. The fake ends each utterance on `setTimeout(0)`. With `withVoices(page, [])` voices never load, so no cue plays and those specs are unaffected. Since this phase, utterances also come from cues: arrival when a card appears, after when the banner appears, and board word taps. A spec that counts utterances must wait for a card's cue before reading its `before` count.

**Files:**
- Modify: `e2e/tests/listening-variety.spec.ts` (the card loop, lines 95-150)
- Modify: `e2e/tests/voice.spec.ts` ('a session prompt speaks'; also any later session steps in 'a saved word speaks…')
- Modify: `e2e/tests/answer-language.spec.ts` (its dictation case, lines 60-100)
- Check: every other spec that calls `withVoices` with a non-empty list: `grep -rn "withVoices(page, \[['\"]" e2e/tests`.
- Read first: `e2e/tests/support/cards.ts` (`readCard`, `Card`, what `card.prompt` holds per kind).

- [ ] **Step 1: `voice.spec.ts`, 'a session prompt speaks'.** After `tapUntil(page, 'start-button', 'progress-label')` and reading `prompt`, assert the seed card spoke its word on arrival with no tap, then keep the tap check:

```ts
  // Phase 44 (spec D2): the card reads its word on arrival, with no tap.
  await expect.poll(() => spoken(page)).toEqual([{ text: prompt, lang: 'it-IT' }]);
  await tapAndHear(page, page.getByTestId('speak-prompt'), { text: prompt, lang: 'it-IT' });
```

If the test signs up with a seed session that only starts after other utterances (lookups), use `spoken(page)` sliced from a `before` read before the start tap instead of comparing the whole list. Check the other tests in the file for session steps that count utterances, and make each wait for the card's cue first.

- [ ] **Step 2: `listening-variety.spec.ts`, card by card.** Inside the loop, after `readCard`, check each kind's cues against `spoken(page).slice(before)`. Keep the existing assertions and add these:
  - `meaning` (typed meaning: target word shown, Hebrew answer): on arrival it says its word. `await expect.poll(async () => (await spoken(page)).slice(before)).toEqual([{ text: <the card's word>, lang: 'ru-RU' }]);` Take the word from `card` as `readCard` exposes it.
  - `typed` and `tiles` (Hebrew prompt, Russian answer): before answering, `expect((await spoken(page)).slice(before)).toEqual([])`. After the feedback shows, `await expect.poll(async () => (await spoken(page)).slice(before)).toEqual([{ text: <right answer>, lang: 'ru-RU' }]);` The right answer is `FORM_OF[card.prompt]` for typed, and the word built from the tiles for tiles.
  - `board`: when `board-word-${i}` is tapped, `spokenAfter(page, n)` (with `n` read just before the tap) equals `{ text: words[i], lang: 'ru-RU' }`. Check it on the first tap of `board-word-0` and on each tap in the loop. A meaning tap adds no utterance.
  - `listen` and `dictation`: as before. After the feedback, the slice still has exactly one utterance (R7, nothing more after the answer).
  - Keep `before = (await spoken(page)).length;` right before the Continue click. Every kind above has now waited for its last cue, so the count is settled.

- [ ] **Step 3: `answer-language.spec.ts`.** Its dictation case reads `before` and uses `spokenAfter`. Make sure any card before the dictation has its cues settled before `before` is read. Apply the same rule to every spec found by the grep in **Files**.

- [ ] **Step 4: Typecheck and commit**

Run: `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default/e2e && npx tsc --noEmit`
Expected: no errors.

```bash
cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-44-voice-by-default && git add e2e/tests && git commit -m "test(e2e): cards read themselves aloud (phase 44)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Report which specs you changed and why, and anything you could not settle without running e2e.
