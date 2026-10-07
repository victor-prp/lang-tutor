# Phase 23 — Voice for words, phrases and sentences

- **Status:** Implemented on branch `phase-23-voice`. The design was decided autonomously on
  2026-10-06. Victor scoped the phase in the one-pager, then asked for the design to be made
  without questions, planned, built and opened as a PR, naming user experience and good
  architecture as what matters most. Every decision is recorded in §1 with its reason, so each
  one can be overturned in review. Two deviations were found while building and are folded in:
  - a Hebrew → target lookup's lines now take their direction from their language (§2);
  - the audio mode is set on iOS only (D8).
- **Date:** 2026-10-06
- **Source:** the one-pager `drafts/2026-10-06-voice-one-pager.md`. `drafts/` is gitignored,
  so everything this spec depends on is restated below.
- **Builds on:** phase 22, which made Italian the third language to learn, and phases 18–21
  (saved words, list-built sessions, progress, the list by lemma).
- **Touches:** ADR 0002, whose R1 gains two packages that only the composition root may
  import (§1 D2). No server change, no wire change, no migration, no new ADR.

## Goal

A learner meets words, phrases and sentences in the language they learn only as text, so they
never hear how any of it sounds. This phase adds passive voice learning: hearing the language,
not saying it.

**Done means:**

1. A learner taps play beside an Italian word, phrase or sentence on the lookup result, in a
   session and in the saved words list, and hears it spoken.
2. The same works for Russian and English.
3. It plays the right text. Pronunciation quality is left for Victor's report after merge.
4. `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass.

Victor then uses it with his Italian words and reports what sounds wrong. That is the real
acceptance, and it happens after merge.

## Scope

**In:**
- a speaker button beside every target-language word, phrase and sentence the app shows as
  content: on the lookup result, in a session and on its results screen, in the saved words
  list and on a word's page;
- every language a learner can enroll in: English, Russian and Italian;
- speech from the device's own speech engine, shown only where the device has a voice;
- sound when an iPhone's ring switch is on silent.

**Out:**
- active pronunciation: the learner speaking and being judged;
- a new listening exercise, such as "hear it, pick the meaning" or dictation;
- Hebrew audio;
- auto-play: the learner taps to hear;
- slow playback or a speed control;
- choosing a voice or an accent;
- offline audio as a promise (device speech happens to need no network, but nothing tests it);
- audio generated on the server (§1 D1 names when to revisit);
- credit in the knowledge dimensions for having listened (§1 D9).

---

## 1. Decisions

**D1. Speech comes from the device, not from the server.** `expo-speech` drives the platform's
own engine: `AVSpeechSynthesizer` on iOS, `TextToSpeech` on Android, `speechSynthesis` in a
browser. It is part of Expo Go, so it runs in the app Victor already uses.

- *UX.* The sound starts the moment the button is pressed. There is no network round trip and
  no spinner, which matters for a feature whose whole use is "tap, hear, tap again".
- *Architecture.* No server endpoint, provider contract, MockServer stub, audio storage or cost
  per lookup. Generated audio would also mean an unauthenticated endpoint that spends money on
  arbitrary text.
- *Quality.* Voices vary by device, and an iPhone can download better ones in Settings. Done
  means "plays the right text", and Victor judges quality after merge.

Rejected: generating speech on the server, for example with Gemini's speech models, and caching
it per text. The first play of every lookup would wait one to three seconds, and it brings
everything listed above. Also rejected: pre-recorded audio, which cannot cover a lookup of
arbitrary text.

**Switch signal:** after merge, Victor reports that a voice sounds wrong in a way a device
setting cannot fix, or that a target language has no voice on his phone. Server audio then
becomes a phase of its own, behind the port in D2, and no screen changes.

**D2. A `Speaker` port, and the screens never name the engine.** `src/speech.ts` declares the
narrow engine type it needs (`speak`, `stop`, `getAvailableVoicesAsync`) and a factory,
`createSpeaker({ engine, platform, prepareAudio })`, which returns closures (ADR 0002 R6). Only
`_layout.tsx`, the composition root, imports `expo-speech` and `expo-audio`. ADR 0002 R1 already
says this of AsyncStorage and `expo-crypto`, and now says it of these two, with the check script
extended to match. That keeps the switch in D1 to one file, and lets the unit tests drive the
speaker with a fake engine and no `jest.mock` (R4).

The speaker is a small store. The provider reads it with `useSyncExternalStore`, so everything
that can go wrong (which languages have a voice, what is playing, stale callbacks) lives in plain
functions that are tested without rendering anything.

**D3. What is voiced: the target language, wherever it is content.** The rule is "the language
being learned, never Hebrew". Every pair includes Hebrew (phase 16), so on any one screen the
non-Hebrew text is the target. Each string's language is known exactly, never guessed from its
script:

| Surface | Voiced text | Its language comes from |
|---|---|---|
| Lookup, target → Hebrew | the headword (D4); each example's `source` | the response's `from` |
| Lookup, Hebrew → target | each sense's `translation`; each example's `target` | the response's `to` |
| Session | the prompt of today's card (target → Hebrew) | the active enrollment |
| Session results | each practised form; each missed prompt | the active enrollment |
| Saved words list | each row's lemma | the active enrollment |
| A word's page | the lemma; each sense's example `source` | the active enrollment |

The two cards added by the question-types phase (#89), `reverse_choice` and `typed_translation`,
ask a Hebrew meaning, so their prompt has no speaker. The results rows still voice every card:
a practised row's `form` and a missed row's word (`missedPair`) are the target word whatever the
type.

`SpeakButton` takes the string and its language, and it renders nothing for a language with no
voice. Hebrew never has one, because it is absent from the voice table, so no call site needs a
Hebrew check of its own. Interface text, options and feedback (all Hebrew) are never voiced.

A word page's example `source` is the target language. Saving happens only on a lookup whose
`from` is the enrollment's target (phase 18), and the seed is target → Hebrew, so every stored
target-language sense was written with its example in `from` = the target.

**D4. A lookup gains a headword row.** Today a target → Hebrew result shows only Hebrew
translations, and the Italian the learner typed sits in the input field above. The result now
opens with that text and its speaker. When a correction is present, the row shows the corrected
form, because the senses describe that form, not the misspelling. For a phrase or a sentence, the
headword is the whole phrase or sentence, which is how the learner hears a sentence they looked
up. A Hebrew → target lookup gets no headword row: the typed text is Hebrew and not voiced, and
the target-language text there is each card's translation, which carries its own speaker.
The row depends on the language, not on the device (`isVoiced(from)`). A device with no voice
for it still shows the headword, which is also where a corrected form is read, just without a
speaker.

**D5. The speaker appears only when the device has a voice for that language.** At start-up the
speaker asks the engine for its voices and marks a language as speakable when some voice's
language tag has that primary subtag (`it-IT`, `it_IT` and `it` all count as Italian). Without
this, a device with no Italian voice reads Italian in its default Hebrew or English voice, which
teaches the wrong sounds and is worse than silence. A button that does nothing is equally bad.
Until the voices load (on the web they can arrive after the first render), no speaker shows; it
appears when they do.

**D6. The language tag depends on the platform.** Each target has a preferred tag: `en-US`,
`ru-RU`, `it-IT`. When the device has no voice for that exact tag, the first available tag for
the language is used instead (`en-GB` on a phone with only British English).

- On iOS and the web, the full tag goes to the engine, and the system picks the user's preferred
  voice for it, including an enhanced voice they downloaded.
- On Android the engine gets the primary subtag, `it`. `expo-speech`'s Android module builds
  `Locale(tag)`, and `Locale("it-IT")` is a language literally named `it-it`. Android reports that
  as unsupported and falls back to the device's default voice, which is the wrong-voice failure D5
  exists to prevent. `Locale("it")` resolves to the engine's Italian voice.

A specific voice identifier is never chosen. iOS lists novelty voices (Albert, Bells, Bad News)
under `en-US`, and picking "the first en-US voice" can land on one.

**D7. Tapping.** A tap stops whatever is speaking and speaks this text at the natural rate
(`1.0`). Nothing is queued: `expo-speech` queues by default, and a learner tapping down a list
wants the word they just tapped, not the backlog. While a button's text is speaking, that button
is shown as playing, and tapping it again stops it. A callback from an utterance that was stopped
cannot clear the playing state of the one that replaced it, because each utterance carries a
ticket and only the current ticket may clear the state. The web engine reports a stop as an
error, not as `onStopped`, so done, stopped and error all end an utterance the same way.

**D8. The ring switch does not silence a tap.** On an iPhone, `expo-speech` is silent while the
ring switch is on silent. A learner who presses play has asked for sound, as in any media app, so
at start-up the speaker sets the audio mode through `expo-audio`:
`playsInSilentMode: true, interruptionMode: 'mixWithOthers'`. That sets the shared audio session
to the playback category, which the synthesizer uses, since its `usesApplicationAudioSession`
defaults to true. `mixWithOthers` keeps the learner's music or podcast playing underneath. The
speaker sets the mode on iOS only. On Android, expo-audio's audio mode is device-wide: it sets
`MODE_NORMAL` and turns the speakerphone on, which could reroute a call the learner is on, and TTS
plays on the media stream there regardless. The web ignores the call. A failure to set the mode is
ignored: speech still works whenever the switch is off.

**D9. Hearing a word earns no progress.** `spoken_receptive` measures understanding speech, and
pressing play proves nothing about that. It stays out of `LIVE_DIMENSIONS` until the listening
exercise, which is Out, feeds it.

**D10. The saved-words row becomes two sibling buttons.** Today the whole row is one button that
opens the word. A speaker nested inside it would be a button inside a button, which screen readers
announce badly. On the web, react-native-web stops the inner click's propagation, so it would
work, but the nesting is still wrong. The row becomes a container holding the opening button
(lemma, badge, translation) and the speaker beside it.

**D11. The button.** A round 40-point button, outlined in the primary colour and filled while
playing, holding a 🔊 glyph. It is a glyph rather than an icon library, as the back arrow is. Its
accessibility label is **השמעה** ("play"), its state reports `selected` while playing (with
`aria-selected` for the web, as the level chips do), and a hit slop makes it easy to hit.

---

## 2. Changes

### Mobile (`apps/mobile`)

- `package.json`: `expo-speech` and `expo-audio`, at the versions SDK 57 pins
  (`expo/bundledNativeModules.json`). `npx expo install` refuses to run under this npm
  (`--allow-scripts`), so they are installed with npm at those exact ranges.
- `src/speech.ts`, new. `VOICE_TAGS` (`en-US`, `ru-RU`, `it-IT`); `isVoiced(language)`;
  `voiceTags(voices, platform)`, a `Map` from each speakable language to the tag the engine gets
  (D5, D6); and `createSpeaker({ engine, platform, prepareAudio })`, a store with `start`,
  `snapshot`, `subscribe` and `toggle`. A `Map`, not an object, so a wire string such as
  `constructor` cannot find a prototype key.
- `src/hooks/useSpeech.tsx`, new. `SpeechProvider` starts the speaker once and exposes
  `canSpeak(language)`, `isPlaying(text, language)` and `toggle(text, language)`.
- `src/components/SpeakButton.tsx`, new (D11).
- `src/app/_layout.tsx`: imports both packages, builds the speaker, and wraps the tree in
  `SpeechProvider`.
- `src/app/translate.tsx`: the headword row (D4), and speakers on each translation and on the
  example half in the target language.
- `src/components/MultipleChoiceView.tsx`: takes the prompt's language and puts a speaker beside
  the prompt. `src/app/session.tsx` passes the active enrollment's target.
- `src/app/results.tsx`: speakers on practised and missed rows.
- `src/app/vocabulary/index.tsx`: the row restructure (D10) and its speaker.
- `src/app/vocabulary/word.tsx`: speakers on the lemma and each example.
- `src/strings.ts`: `speak: 'השמעה'`, and `textDirection(language)`. A screenshot taken while
  building showed that a Hebrew → target lookup forced its target-language translation and
  example right-to-left, so an Italian example's full stop led its line and the word sat away
  from its speaker. That bug predates this phase. Each lookup line now takes its direction from
  the language the response says it is in, so those lines align left, beside their speaker.

### Architecture

- ADR 0002: R1 names `expo-speech` and `expo-audio` beside AsyncStorage and `expo-crypto`. Its
  detection command and `scripts/check-adr-0002-di-with-closures.sh` change together, and a
  planted import must make the check fire before it counts (CLAUDE.md). R6's list of factories
  gains `createSpeaker`.

### Server, wire, database

None. The voiced strings are already on the wire, and so are their languages.

---

## 3. Testing

### Unit (`apps/mobile/src/speech.test.ts`)

- `createSpeaker` sets the audio mode on iOS only, never on Android or the web.
- `voiceTags`: the preferred tag when present; another region of the same language when it is
  not; `it_IT` and lowercase tags normalised; a Hebrew voice never makes Hebrew speakable; a
  language with no voice is absent; Android gets primary subtags.
- Every `ENROLLABLE_TARGETS` code has a `VOICE_TAGS` entry, so a fourth target cannot ship
  silent by accident.
- `createSpeaker`: `start` prepares audio and loads voices; a rejected `prepareAudio` still loads
  voices; rejected voices leave nothing speakable; `toggle` stops, then speaks with the tag and
  rate `1`; the playing state is set and cleared on done, stopped and error; a stale callback
  from a replaced utterance leaves the new one playing; toggling the playing text stops it;
  toggling a language with no voice does nothing; subscribers hear every change.

### e2e (`e2e/tests/voice.spec.ts`)

Chromium has no voices in CI, so an init script replaces `speechSynthesis` with a recorder: it
reports `it-IT` and `en-US` voices, stores each utterance's text and `lang`, and ends it at once.
This exercises everything except the sound itself, including `expo-speech`'s real web module.

1. An Italian learner looks up an Italian word: the headword speaker speaks it as `it-IT`, the
   Italian example speaks, and no speaker sits on Hebrew text. After a flip, a Hebrew → Italian
   lookup's translation speaks Italian.
2. In the first session, the prompt's speaker speaks the prompt.
3. In the saved words list, the row's speaker speaks the lemma without opening the word, and the
   word's page speaks its lemma.
4. With only an `en-US` voice, an Italian learner's lookup shows no speaker.

### Not testable in CI

The sound itself, the ring-switch behaviour (D8) and Android's tag handling (D6). These are on the
PR's checklist for Victor's device.

---

## Build order

1. `src/speech.ts` and its unit tests.
2. ADR 0002 R1 and its check, made to fire on a planted import first.
3. The provider, the button and the composition root.
4. The screens.
5. The e2e spec.

## Risks

- **Voice quality is the device's.** That is accepted by D1, and the switch signal says when it
  stops being acceptable.
- **Android may list a voice that is not installed.** `expo-speech` exposes no "not installed"
  flag, so D5 can show a speaker that then plays in the default voice until the engine downloads
  the language.
- **The ring-switch fix is unverified on a device.** It follows from the code of both packages
  (§1 D8), not from a test.
- **Speakers appear a moment late on the web**, when the browser loads its voices after the first
  render.
