# Phase 44 — Voice by default

- **Status:** Scoped with Victor on 2026-10-13 (one-pager), then "go till PR, subagents", with
  Duolingo as the reference for every open question: the design is self-approved (CLAUDE.md,
  *Continue till PR*). Rulings are at the end.
  Implemented on branch `phase-44-voice-by-default` from
  `docs/superpowers/plans/2026-10-13-phase-44-voice-by-default.md`. The final review added R12 and
  two fixes: leaving the session stops speech, and R1 now says it overrules phase 25 D2.
- **Date:** 2026-10-13
- **Source:** the one-pager `drafts/2026-10-13-voice-by-default-one-pager.md` (gitignored; its
  Done-means are restated below).
- **Builds on:** phase 23 (the speaker, tap to play), phase 24 D6 (a listening card plays on
  arrival), phase 25 (speaking cards), phase 42 (the second try).

## Goal

A learner reads words in a session but hears them only if they think to tap play, so most words
go by unheard. After this phase a session sounds the way Duolingo does: a card reads its
target-language text aloud when it appears, unless hearing it would give the answer away, and a
card that stayed silent reads the right answer once the answer is checked.

**Done means:**

1. Every session card makes a sound at least once, when it appears or after its answer is
   checked, unless the device has no voice for the language (the board: when its words are
   tapped, R3).
2. No card plays the text the learner has to produce before they answer. Dictation and read
   aloud are the two cards where hearing it is the exercise itself (R1, R2).
3. Victor's own use after merge: sessions feel like Duolingo, not annoying.

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass, and
`TIER2_THRESHOLD` is not lowered.

## Scope

**In:** session cards only, in the app: what each card type says on arrival and after its answer
(D1), when it says it (D2), the speaker's `say` and `stop` (D3), the microphone stopping speech
(D4), the board's words speaking when tapped (D5).

**Out:**

- auto-play outside sessions: the lookup result, the saved list, a word's page and the results
  screen stay tap-to-play;
- more voice cards: the picker's mix of card types stays;
- reading each answer option or letter tile aloud when tapped;
- Hebrew audio, slow playback, choosing a voice (as phase 23);
- credit in the listening skill for an auto-played card;
- a mute switch or "can't listen now": the phone's volume handles it, and Victor's use decides
  whether one is needed;
- any server, wire or prompt change: no `API_LEVEL` bump (R10).

## D1. What each card says

A pure function, `cardVoice(question, { speaking })` in `apps/mobile/src/cardVoice.ts`, gives
each card two cues, each a target-language string or nothing:

| type | on arrival | after the answer |
|---|---|---|
| `multiple_choice`, `new_meaning`, `typed_meaning` | the word (`question`) | — |
| `listen_choice`, `dictation` | the word (`question`), as today | — |
| `read_aloud` | the word (`question`) (R1) | — |
| `reverse_choice` | — | the right option |
| `typed_translation`, `letter_tiles`, `say_translation` | — | `answer` |
| `cloze_choice`, `cloze_typed` | — | the whole `sentence` (R4) |
| `sentence_translation` | — | the reference `sentence` |
| `matching` | — | — (the board speaks on tap, D5) |

`say_translation` shown as a typed card (speaking off) keeps its cues. `read_aloud` while speaking
is off has none: the card is passed without being shown.

## D2. When a card speaks

A pure step, `nextCue(state, input)` in the same module, decides; a thin hook,
`useCardVoice`, runs it in `app/session.tsx` and calls the speaker. Its input is the card's id,
its cues, whether the device has a voice for the target, and whether the answer banner is
showing.

- **Arrival:** the arrival cue plays once per card id, as soon as there is a voice. Voices that
  load late still play it, if the card is unanswered. Nothing waits on the voices: no tap is held
  for them (phase 43 R9).
- **After the answer:** the after cue plays once, when the banner appears, on a right answer and a
  wrong one alike (R5). A second-try hold shows no banner and plays nothing (R6). A skip plays
  nothing.
- **Once per card:** a card that spoke on arrival does not speak again after the answer (R7). Its
  speaker button still replays.
- **Next card:** moving on, or leaving the session, stops any speech still playing (R8).

`ListenPrompt` loses its own auto-play effect: listening cards play through the same step, so one
place decides when a card speaks (R2).

## D3. The speaker

`createSpeaker` in `apps/mobile/src/speech.ts` gains two calls beside `toggle`, and `useSpeech`
exposes them:

- `say(text, language)` speaks, stopping whatever is playing, and never toggles off. No voice for
  the language: nothing.
- `stop()` ends any utterance and clears `playing`.

`toggle` keeps its behaviour, written on top of the two. While a cue plays, the matching speaker
button shows as playing, and a tap stops it.

## D4. The microphone

`SpeakingCardView` calls `stop()` before starting the recorder, so a read-aloud card's arrival cue
is never recorded as the learner's answer (R9).

## D5. The board

Tapping one of the board's target-language words says it (R3). Its Hebrew meanings stay silent.

## Testing

- **Unit (`apps/mobile`, jest):**
  - `speech.test.ts`: `say` speaks and never toggles off, it stops the utterance in progress
    first, and it is silent with no voice; `stop` clears `playing`.
  - `cardVoice.test.ts`: the D1 table for all fourteen types. Done 1: every type but `matching`
    has a cue. Done 2: no type whose answer is target-language text has an arrival cue, except
    `dictation` and `read_aloud`. `nextCue`: arrival plays once and waits for a voice; the after
    cue plays once, on the banner; nothing plays on a hold or a skip; a new card stops speech.
- **e2e:** `listening-variety.spec.ts` (ru-RU voice, seven card kinds) asserts, card by card: the
  meaning card spoke its word on arrival with no tap; the typed card and the tiles spoke nothing
  before Check and their answer after; a board word speaks when tapped; listen and dictation as
  before. `voice.spec.ts` checks that the seed's first card speaks on arrival, and its
  utterance-counting steps and `answer-language.spec.ts` wait for the arrival cue before counting.
  Specs with `withVoices(page, [])` never load voices, so nothing plays there.

## Rulings

Made under *Continue till PR*, with Duolingo as the reference.

- **R1. Read aloud plays its word on arrival.** Duolingo plays the sentence before the learner
  repeats it. The word is already on screen, so hearing it gives a model, not the answer.
  It overrules phase 25 D2 ("no speaker before the answer, or reading becomes repeating"): Victor
  made Duolingo the reference, and the one-pager did not list read aloud among the silent cards.
- **R2. Listening cards keep their audio, moved into D2.** Their sound is the question (phase 24
  D6); one mechanism now plays every card.
- **R3. The board speaks a target word when tapped.** Its target words are the board's prompts,
  and Duolingo's match exercise speaks them on tap. This is how a board meets Done 1. The Out
  line about options covers the Hebrew meanings, which stay silent.
- **R4. A gap card is silent on arrival and plays the whole sentence after.** Speaking the
  sentence would fill the gap, and a speech engine cannot say a blank. Duolingo's fill-in-the-blank
  plays the sentence once it is answered.
- **R5. The after cue plays on wrong answers too:** the learner hears the right form either way.
- **R6. No after cue on a second-try hold:** it would give the second try away (phase 42).
- **R7. Once per card.** A target-to-Hebrew card does not replay its word after the answer, as on
  Duolingo. The button is there for more.
- **R8. Moving on stops speech:** an answer still playing does not run into the next card, or onto
  Results or home.
- **R9. The microphone stops speech first,** or the recorder would hear the app.
- **R10. No `API_LEVEL` change:** nothing on the wire changes (ADR 0012).
- **R11. All nine lanes were taken,** so integration and e2e ran in CI only; nothing was retired
  to free one.
- **R12. Read aloud can replay its word before the answer.** Duolingo's speaking exercise has a
  replay, and D2 promises the button is there for more. It hides while the microphone listens, so a
  tap cannot be recorded.
