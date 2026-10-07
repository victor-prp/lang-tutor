# Phase 25 — Speaking cards

- **Status:** Planned and built on 2026-10-07 on phase 24 Part A (#93); see the plan
  `docs/superpowers/plans/2026-10-07-phase-25-speaking.md`. Victor scoped the phase in the
  one-pager, approved the recognition path (D1, D13), then handed the remaining decisions over
  ("Go with all the rest section alone. I trust your decisions"). Every decision is in §1 with its
  reason, so each one can be overturned in review. Those marked **(low confidence)** are the ones
  to read first. A POC on the same day replaced the feasibility step with measured facts
  (§ POC findings), and Victor moved short phrases in after it (D3). Where the build departed from
  what was first written here, the decision says so ("as built") and "Deviations as built" at the
  end of §1 lists them.
- **Date:** 2026-10-07
- **Source:** the one-pager `drafts/2026-10-07-speaking-one-pager.md`. `drafts/` is gitignored, so
  everything this spec depends on is restated below.
- **Builds on:** Part A (#93); Part B is not required, and inserts its cloze types into these tiers
  when it lands. Phase 24 as designed, both PRs
  (`docs/superpowers/specs/2026-10-07-lang-tutor-phase-24-more-question-types-design.md`, merged as
  #93): the tiered planner (D3), eligibility (D4), the listening flag (D5), dictation's shape and `spoken_receptive` live (D13). Phase 23 (#89:
  `judgeTyped`, the typed card and "show the answer"; #90: `SpeakButton`, `expo-audio` in the
  composition root, the iOS audio mode). Phase 20 (five dimensions per saved sense, the evidence
  table in its §3, "a recogniser reject is no evidence, never wrong").
- **Touches:** the wire's `Question` union gains two members, `NextStepRequest` one body,
  `CreateSessionRequest` one field, and there is one new endpoint, all additive under ADR 0003. A
  new contract, `SpeechTranscriber`, sits beside `LlmClient` under ADR 0001 R11. ADR 0002 R1 gains
  `expo-file-system`, with its existing check script extended, and R6's list of factories gains
  two. No new check script.

## Goal

Since phase 23 a learner can hear a word, and since phase 24 they are tested on hearing it, but
they never say one. `spoken_productive` is the one dimension nothing can move. This phase adds two
speaking cards, at two levels:

- **read aloud** (the basics): the word in the language being learned is shown, and the learner
  says it;
- **say the translation** (more advanced): the Hebrew meaning is shown, and the learner says the
  word.

After every attempt the card says whether the app understood the word, and shows what it heard.

**Done means:**

1. With speaking available and eligible saved items, list sessions include both speaking cards, and
   four list sessions in a row show both (D3). Two cards in a row never share a type.
2. A say-the-translation answer the app understands moves `spoken_productive` above "not
   practised". Read aloud alone takes it no higher than level 2 (D10).
3. After every spoken attempt the card shows what the app heard. An attempt it did not understand
   records nothing and can be tried again (D5, D7).
4. "Can't speak now" turns the session's remaining say-the-translation cards into typed cards and
   passes its read-aloud cards. A passed card is left out of the score (D8, D9).
5. Each outcome above is checked by an automated test. `npm test`, `npm run test:all`,
   `npm run lint:arch`, `npm run e2e` and `npm run eval` pass. The eval has transcription cases,
   and `TIER2_THRESHOLD` is not lowered.
6. Victor's own use after merge, with his Italian words, decides whether the wait and the
   accuracy are good enough. There is no number. The `speech_judged` log (D13) gives the measured
   wait and the share of attempts understood, so the report can be checked against them.

## Scope

**In:**
- `read_aloud` and `say_translation`, end to end, for every target language, for saved words and
  for saved phrases of up to four words (D3);
- recording in the app with `expo-audio`, transcription on the server by Gemini, and
  `judgeSpoken` in `packages/core`;
- a speaking flag from the app, and the two types in phase 24's planner;
- "can't speak now", for the rest of a session;
- `spoken_productive` going live;
- transcription eval cases with recorded audio.

**Out:**
- scoring pronunciation quality, such as accent or stress: only whether the word was understood;
- sentences: a saved item of more than four words gets no speaking card (D3). The one-pager put
  phrases Out too; Victor moved short phrases In on 2026-10-07, after the POC;
- speaking outside a session, such as on a word's page or a lookup result;
- Hebrew speech;
- a setting to switch speaking cards off: "can't speak now" lasts one session (D8);
- a "can't listen now": phase 24 D6 stands;
- changes to the seeded first session, timed rounds, and a card's type from the word's level, as
  in phases 23 and 24;
- recognition on the device and dedicated speech-to-text services (D1, switch signal);
- stopping on silence, and a live transcript while speaking (D7);
- keeping audio: a clip is transcribed and dropped, never stored or logged (D13).

---

## 1. Decisions

**D1. Recognition happens on the server, by Gemini, blind.** Victor chose this on 2026-10-07 over
recognition on the device and over a dedicated speech-to-text service.

- *Why not the device.* `expo-speech-recognition` is not part of Expo Go. Using it means a
  development build of the app, installed through Xcode (re-signed every seven days on a free
  Apple account) or EAS (the paid developer programme), and a rebuild for every later native
  dependency. On the web it is Chrome only, and headless e2e cannot recognise anything, so CI
  would test a fake.
- *Why not a dedicated service.* A second vendor, account and key. Its phrase hints, which make
  it good at single words, bias it towards the expected word, which undermines "what the app
  heard".
- *Why Gemini.* `expo-audio` is installed and is part of Expo Go. One recogniser serves iOS,
  Android and the web, so e2e drives the real path with a fake microphone and a MockServer answer.
  The provider and its key exist, and the transcriber can be scored in `npm run eval`.
- *Blind.* The model is told the language and never the expected word. Told the word, a model
  tends to hear it, and "what the app heard" would stop being true. Judging happens afterwards, in
  a pure function (D6).
- *The wait,* measured in the POC: **about 1.7–2.0 s** after the learner stops, almost all of it
  the model call (1.73 s at the median and 2.0 s at the 90th percentile over Victor's 14 attempts on
  Android). Reading and uploading a clip of about 13 KB add little. Victor judged it good enough to
  build on ("works well"), and his use after merge is still the acceptance. `transcribe_ms`
  keeps measuring it.

**Switch signal:** after merge, Victor reports that the wait is too long, or that the app often
mishears a word he said right. A dedicated speech-to-text service then becomes a phase of its own
behind `SpeechTranscriber`, with no change to the app. Recognition on the device follows only if
leaving Expo Go becomes acceptable.

**D2. Two types.**

| Type | Before the answer, the card shows | The learner | Model task |
|---|---|---|---|
| `read_aloud` | the form, written, with no speaker | says it | none |
| `say_translation` | the Hebrew meaning and its part of speech (phase 23 D4) | says the word | `typed`, for its alternatives |

- `read_aloud` carries `question` (the form) and `meaning`, shown after the answer and read by the
  missed list, as phase 24's dictation does. Its form has no speaker before the answer, because
  hearing it first turns reading aloud into repeating. A speaker appears after the answer, and
  after an attempt that was not understood, so the learner can hear how the word sounds before
  trying again (D7).
- `say_translation` carries what `typed_translation` carries: `question` (the Hebrew),
  `part_of_speech`, `answer`, `lemma` and `alternatives`. That is also exactly what its typed form
  needs when the learner cannot speak (D8).
- **Storage** follows phase 24 D15. `read_aloud` keeps the meaning in `questions.prompt`, as
  dictation does. `say_translation` keeps the Hebrew in `questions.prompt` and the `typed` task's
  alternatives in `questions.alternatives`, as `typed_translation` does.

**D3. The planner places them in phase 24's tiers. (low confidence on read aloud's tier)**

| Tier | Types, in rotation order |
|---|---|
| recognise | `multiple_choice`, `listen_choice`, `read_aloud` |
| pick the form | `reverse_choice`, `letter_tiles` (Part A's; Part B inserts `cloze_choice`) |
| produce | `typed_translation`, `dictation`, `say_translation` (Part B inserts `cloze_typed`) |

**As built:** the tiers hold Part A's types plus the two. Speaking off removes the speaking types
before the rotation, so a session without speaking is planned exactly as phase 24 plans it.

- **Read aloud is a warm-up,** so it opens a run, where recognition sits. The form is in front of
  the learner and nothing has to be recalled.
- **Say the translation is recall,** so it closes a run, beside the typed card.
- **Each is appended to the end of its tier,** so the rotation, `tier[(k + r) mod size]`, keeps
  phase 24's order and only grows. As built on Part A the tiers cycle three, two and three types.
  With every type eligible, two ten-word sessions in a row show every type of every tier, and a
  session with a single run needs up to three; Done means 1's four sessions is a loose bound over
  both. Part B's cloze types make the tiers three, three and four, and a ten-word session then
  shows every type within three sessions.
- **Eligibility** (phase 24 D4), for both: the session was created with speaking on (D4), and the
  form, with stress marks removed, has at most four words. An elision such as `l'acqua` is one
  word. An ineligible pick falls through its tier as phase 24 says, ending at the always-eligible
  type.
- **Phrases are in, sentences are out.** The one-pager put both Out. In the POC (2026-10-07) every
  phrase Victor said came back exactly (`per favore`, `caffè con cornetto`), and he moved short
  phrases In: a saved `per favore` is exactly what a learner wants to practise saying. Four words is
  where a phrase ends. Beyond it, one slip turns the whole item into "not understood", and saying a
  sentence is another exercise.
- **Two cards in a row still never share a type,** since consecutive single cards sit in
  different tiers.
- **A one-word session gets no speaking card.** Its only card sits in the recognise tier and could
  be read aloud, which "can't speak now" passes, leaving a session with nothing to score (D9). The
  pick falls through to `multiple_choice`. From two words on, the second card is in "pick the
  form", which has no speaking type.

**D4. The speaking flag comes from the app.** This follows the listening flag (phase 24 D5).
`CreateSessionRequest` gains `speaking: boolean`, optional and false when absent. The
prepare-session payload carries it with the same default, so a job enqueued before the deploy
prepares a session without speaking cards.

**As built:** on the web only a *granted* microphone counts (read from `navigator.permissions`),
because `expo-audio`'s web permission read opens the browser's prompt when the permission was never
granted, so it cannot be read at session start. A site that never granted gets no speaking cards, and
the other e2e specs, which never grant it, plan as before. On a phone the rule below stands.

The app sends true when it has a recorder and the microphone permission is not denied. "Not yet
asked" counts as yes on a phone, because the permission is asked on the first tap of a microphone button
(D7), never at session start, where the learner would not know why. On iOS a denial holds until
the learner changes it in Settings, so later sessions are planned without speaking cards.

**D5. One endpoint answers a speaking card by speech, and an attempt the app did not understand
records nothing.**

**As built:** a session id held by another learner is a 404, as an unknown session is. A clip under
1 000 base64 characters (about 750 bytes) is heard as nothing without a model call: it holds no word,
and Gemini answers an empty input with a 400.

`POST /api/sessions/{id}/speech` takes `user_id`, `question_id`, `mime_type` and `audio`
(base64). The service:

1. loads the session, and checks that the question is its current one and of a speaking type. If
   it is instead the question answered just before, the request is a retry: the stored answer
   comes back, and the model is not called. This is how `step` treats a replay;
2. transcribes outside any transaction, so no database transaction waits on the network;
3. judges what was heard (D6);
4. **if the word was not understood,** writes nothing and returns `{ heard, verdict: 'unheard' }`.
   Phase 20 says a recogniser reject is no evidence and never wrong. The card stays current, so
   another attempt is just another upload;
5. **if it was understood,** steps the session with the transcript in one transaction, exactly as
   a next-step does, and returns `{ heard, verdict, next }`. `next` is the next-step response, which
   the app queues while the banner shows, as it does for a typed answer (phase 23 D9).

**A clearly heard other word is also "not understood".** `cane` for `gatto` and a mumble look the
same to a blind transcriber's judge: neither contains the target. The transcript on the card shows
the learner which happened. A learner who does not know the word has "show the answer" (D7).

**Two buttons answer a speaking card without audio,** through `next-step`, which gains a third
body: `{ user_id, question_id, pass: 'skip' | 'show_answer' }`.

- `skip` gives verdict `skipped`: no evidence, and out of the score (D9). It comes from "continue"
  after an attempt that was not understood, and from "can't speak now" on a read-aloud card (D8).
- `show_answer`, on `say_translation` only, gives verdict `gave_up`: a recall failure (D10),
  counted wrong, as the typed card's empty answer is.

The typed form of a say-the-translation card (D8) answers through the existing `text` body and is
judged by `judgeTyped`, with typed verdicts. The stored verdict therefore says how the card was
answered, and evidence never takes a typed answer for a spoken one.

**D6. `judgeSpoken(target, heard)` in `packages/core`.** It is pure, sits beside `judgeTyped`, and
uses `judgeTyped`'s normalising: NFC, case, the typographic apostrophes, Cyrillic stress marks,
trailing punctuation and one leading article. Then:

- **Diacritics are folded,** with the breve kept, as `judgeTyped`'s near-miss rule already does
  (`й` is its own letter). A transcript's spelling is the model's, not the learner's: `perché`
  transcribed as `perche` was said right. Spelling evidence comes only from typed answers
  (phase 20).
- **The target is a run of words among the heard words. (low confidence)** The transcript and the
  target are each split into words, and the target's words must appear in the transcript in
  order, side by side: `um, gatto` and `il gatto` are understood, and so is `per favore` said as
  two words. It compares words, never substrings, so `gatto` is not found in `gattone`. The cost is
  that a learner who says two guesses is understood, a little over-credit on recall. The
  alternative is a false "not understood" every time a filler word or an article is transcribed,
  which would be far more common.
- **Targets.** For `read_aloud`, the form only. A learner shown `parlo` who says `parlare` did not
  read what was shown. For `say_translation`, the form or its lemma gives `understood`, as typing
  either does (phase 23 D5), and one of the alternatives gives `alternative`: right, but not this
  word.
- **No near miss.** A transcript one letter off (`gato` for `gatto`) means the recogniser heard
  another word, often because of the very sound the learner got wrong, such as an Italian double
  consonant. "We heard *gato*" is the feedback they need, so it is `unheard`.
- **An empty transcript,** where the model heard nothing intelligible, is `unheard`, shown as "we
  heard nothing".

**D7. The card.**

- **A microphone button,** round and large like a listening card's play button (phase 24 D6),
  holding a 🎤 glyph. Phase 23 voice D11 chose a glyph over an icon library. Tap to start, tap
  again to stop. Recording stops itself at five seconds. While recording, the button is filled and
  a line counts the seconds left. Its accessibility label is **הקלטה** ("record"), and its state
  reports `selected` while recording.
- **Tap to stop, not stop on silence.** Detecting silence waits half a second or more after the
  word on every attempt, and fails in a noisy room. A tap is instant and under the learner's
  control.
- **The first tap asks for the microphone** (D4). A denial turns speaking off for the session, as
  "can't speak now" does (D8), with the line **אין גישה למיקרופון** ("no access to the
  microphone").
- **While the clip is checked,** the button is disabled and reads **בודקים…** ("checking").
- **Instructions:** **קראו בקול** ("read aloud") on read aloud, and **אמרו באיטלקית** ("say it in
  Italian") on say the translation, with the language named from the active enrollment, as
  phase 23 D9 does.
- **Under the button:** **אי אפשר לדבר עכשיו** ("can't speak now", D8) on both cards, and
  **הצגת התשובה** ("show the answer") on say the translation until it is answered.
- **Banners:**

| Outcome | Banner | Colours | Then |
|---|---|---|---|
| `understood` | **נכון! שמענו:** what was heard | correct | the form with its speaker, and on read aloud the meaning; continue |
| `alternative` | **נכון! המילה שתרגלנו:** the form, then **שמענו:** what was heard | correct | continue |
| `unheard`, with text | **לא הבנו. שמענו:** what was heard | neutral | **נסו שוב** ("try again"), **המשך** ("continue", D5 `skip`) |
| `unheard`, empty | **לא שמענו כלום** ("we heard nothing") | neutral | the same two |
| the transcriber failed | **לא הצלחנו לבדוק** ("we couldn't check") | neutral | the same two |
| `gave_up` | **התשובה הנכונה:** the form | wrong | continue |

- **Not understood is neutral, never red,** because it is not wrong (D5). On read aloud it also
  shows the form's speaker, so the learner can hear the word before trying again. On say the
  translation it does not, because hearing the answer would turn the next attempt into repetition.
  "Show the answer" is there for a learner who is stuck.
- **Results** need no new mechanism. `raised` names **דיבור** from the existing
  `DIMENSION_NAMES`. A missed row reads word → meaning (`missedPair`, extended). A skipped card
  appears in neither list.

**D8. "Can't speak now" lasts the rest of the session. (low confidence)**

- **Say the translation becomes the typed card,** with the same prompt, answer, lemma and
  alternatives, phase 23's instruction **כתבו את המילה באיטלקית**, and phase 23's judge and
  banners. The learner keeps practising recall, and the answer is typed evidence (D10). The card's
  type does not change on the server. The answer's kind and verdict record how it was answered
  (D5).
- **Read aloud is passed** with `skip`, without being shown. There is nothing to type for a word
  that is already on the screen, and a bus is where the learner wants fewer taps. The position
  counter moves past it.
- **For this session only,** held in the app's session state. The next session asks again.
  Duolingo offers 15 minutes or an hour. Here the session is the unit, and a session usually fits
  in one sitting.
- **Phase 24's listening cards are not affected.** Its D6 rejected a "can't listen now", and
  that is a separate decision.

Rejected: passing say the translation too. It throws away a recall card that typing can answer,
and leaves a bus session thin.

**D9. A skipped card is left out of the score.** `score` counts as `total` only the cards that
were not skipped, and `missed` leaves skipped cards out. A skip is not a failure. Counting it as
one would let "can't speak now", and a recogniser that keeps failing, lower the score, which is
what phase 20's "never wrong" forbids. Every session holds a card that cannot be skipped (D3's
one-word rule), so a total of zero cannot happen.

**D10. Evidence.** This continues phase 20's §3 table, phase 23 D6 and phase 24 D12 under their
rules: productive success credits receptive within its modality, only successes are credited
downward, and nothing crosses modalities.

| Type | Verdict | `spoken_receptive` | `spoken_productive` | Written dimensions |
|---|---|---|---|---|
| `read_aloud` | `understood` | — | ✓ capped at 2 | — |
| `read_aloud` | `skipped` | — | — | — |
| `say_translation` | `understood` | ✓ | ✓ | — |
| `say_translation` | `alternative`, `skipped` | — | — | — |
| `say_translation` | `gave_up` | — | ✗ | — |
| `say_translation` | a typed verdict (D8) | — | — | as `typed_translation` |

- **Read aloud is capped at 2. (low confidence)** Saying a word that is in front of you shows
  the learner can say it so it is understood. That is part of `spoken_productive` ("given the
  Hebrew meaning, say the word so that it is recognised"), but none of the recall the dimension is
  for. It is weaker evidence than recognition-supported production, which phase 20 caps at 3, so
  its cap is lower. Level 2 is the first successful day, so read aloud shows "said it", and only
  say the translation takes the dimension further. It credits nothing downward: reading a word
  aloud shows nothing about understanding it when heard. Without any credit, read aloud would be
  the first card since phase 24 that moves nothing, against phase 24's Done means 4.
- **The cap becomes a level.** Phase 20 stores `capped: boolean` with `CAPPED_MAX_LEVEL = 3`.
  Evidence now carries `cap: 2 | 3 | null`. A day's cap is the highest of its pieces' caps, and an
  uncapped piece lifts it to `MAX_LEVEL`. When every cap is 3, that is today's rule.
- **"Show the answer" is a recall failure** on `spoken_productive`, as the typed card's is on
  `written_productive`. An attempt that was not understood is not recorded at all (D5).

**D11. `spoken_productive` goes live, and badges recalibrate once.** `LIVE_DIMENSIONS` becomes all
five dimensions. Phase 20 made the badge the mean over live dimensions, rounded to the nearest
level, and accepted that each dimension going live drops badges once. Phases 23 and 24 did the
same.

- **The drop is at most one level.** A word at (4, 4, 4, 4) reads 4 today, and
  (4, 4, 4, 4, 1) reads 3. A word at (3, 3, 3, 3) still reads 3.
- **A learner who never speaks** tops out at a badge of 4, as a device with no voice does under
  phase 24 D13.
- **Announced in the PR,** as both earlier recalibrations were.

**D12. Recording.** `apps/mobile/src/recording.ts` declares the narrow engine it needs and a
factory, `createRecorder({ engine, platform, prepareAudio, readBase64 })`, which returns closures
(ADR 0002 R6), as `createSpeaker` does. Only `_layout.tsx` imports `expo-audio` and
`expo-file-system` (ADR 0002 R1). It builds the engine from the class `useAudioRecorder` wraps, so
no hook is needed. The class is `AudioModule.AudioRecorder` on a phone and
`AudioModule.AudioRecorderWeb` on the web, which has no `release()` (POC).

- **Formats.** Android records AAC in ADTS, 16 kHz mono, sent as `audio/aac`; iOS records AAC in
  M4A, 16 kHz mono, sent as `audio/mp4`; the web records the browser's WebM (Opus), the only format
  Chrome's `MediaRecorder` offers, sent as `audio/webm`. Gemini accepted all three as they are in
  the POC, WebM included although its documentation does not list it. AAC keeps a clip near
  13 KB, where WAV would be about 32 KB a second.
- **Silence around the word matters.** In the POC, half-second clips with no silence around the
  word failed on 4 to 6 of 20 words said right (`лук` came back as `хлеб`). The same words with
  0.6 s of silence on each side were all right. A tap-to-stop recording has that silence, so the
  recorder must never trim it, and the eval's fixtures are made with it (§2, Eval).
- **The iOS audio mode.** Recording needs `allowsRecording: true`, which moves iOS to the
  play-and-record category, where speech plays from the earpiece. The recorder therefore sets it
  just before recording and clears it right after, so every speaker button keeps sounding as
  phase 23 voice D8 set it up. On Android and the web the mode is not touched, as there.
- **Reading the clip as base64.** On a phone, `expo-file-system`'s `new File(uri).base64()`, which
  is part of Expo Go. In the POC, fetching the `file://` URI and reading the blob with `FileReader`
  uploaded 15 bytes from Android. On the web the URI is a `blob:` URL, which `fetch` and
  `FileReader` read; `fetch` must not be called as a method of another object, which a browser
  refuses as an illegal invocation. `expo-file-system` joins `apps/mobile/package.json` at the
  range SDK 57 pins (`~57.0.5`) and ADR 0002 R1's list.
- **Five seconds at most,** and the clip is dropped once uploaded.

**D13. The transcriber.**

- **A contract of its own.** `services/speech.ts` declares
  `SpeechTranscriber = (request: { audio: string; mimeType: string; language: Language }) =>
  Promise<string>` (as built: see "Deviations as built"), beside `LlmClient` and in its style: types only, an empty string means
  nothing was heard, and every failure throws `LlmUnavailable`. `providers/gemini.ts` gains
  `createGeminiTranscriber`, with `createGeminiClient`'s deps, and only `composition.ts` wires it
  (ADR 0001 R11). `LlmClient` stays text only, because widening it for audio would widen it for
  every caller.
- **The request.** One `generateContent` call. The system instruction names the language and asks
  for the words spoken, in that language's standard spelling, and for nothing if nothing
  intelligible was said. The audio goes as `inlineData`, and the response is JSON
  `{ heard: string }`. The instruction carries a fixed marker, `transcribe the spoken audio`, so
  MockServer can tell this call from the others, as `three wrong answers` does today.
- **Thinking off.** The request sends `thinkingBudget: 0`, which the configured `gemini-2.5-flash`
  accepts. It saves about 0.3 s. A text-only call takes about 0.45 s, so roughly a second of each
  call is the model processing audio, whatever the settings. The other calls send no thinking
  setting today, and this phase does not change them.
- **The model stays `GEMINI_MODEL`.** In the POC, the newer Flash models (3.5, 3.6, 3.8) and
  3.1 Flash-Lite were no more accurate and not faster by enough to matter. 3.8 Flash was slower
  (2.9 s at the median) and refuses `thinkingLevel: 'minimal'`. A change of model re-checks the
  thinking field it accepts.
- **The instruction** is the one the POC used: the language, "write exactly the words that were
  spoken, in its standard spelling with its accents", "do not correct the speaker or guess what
  they meant", and an empty answer for nothing intelligible. With it, `gato` and `люк` came back as
  said, not as the target.
- **A budget.** `SPEECH_TIMEOUT_MS`, default 8 000. At the budget the call aborts, the endpoint
  answers 502 as a lookup does when the model fails, and the card offers to try again (D7). No
  retry: the learner's "try again" is the retry, as `createGeminiClient` already reasons.
- **Bounded spending.** Audio is accepted only for the session's current, unanswered speaking
  card, from the user who owns the session. A clip is at most 200 KB (`audio` at most 270 000
  base64 characters), behind a 300 KB body limit on the route, and one upload makes one model
  call. ADR 0005 stands: there is no authentication.
- **Measured.** Each upload logs `speech_judged` with `question_type`, `verdict`, `heard`,
  `transcribe_ms`, `bytes` and `mime_type`. Those are the numbers behind Victor's report: the wait,
  and how often the app understood. The duration comes from the `now` collaborator phase 24 adds.
  The audio itself is never stored or logged.

**D14. The speech request is JSON with base64 audio.** ADR 0003 wants every endpoint declared once,
with a Zod schema in `packages/core`. A JSON body with a base64 string is one more schema. A
multipart upload would need a file type in a package the app imports as types only, and for a clip
of at most 200 KB, base64's extra third costs nothing worth that.

---

### Deviations as built

- A transcript is stored truncated to 100 characters (`answers_typed_text_length`).
- A retried upload replays the stored answer only when it was `understood` or `alternative`; any
  other last answer to that question (a pass, a typed answer, `gave_up`) is a 409
  `QuestionDesynced`, since replaying a pass as "understood" would claim the word was heard.
- A failed transcription is logged as `speech_failed` and rethrown, so the timeouts D13 asks about
  leave a trace.
- The five-second limit is the card's timer, its arithmetic a pure, unit-tested `secondsLeft`.
- The card refuses a second answer while checking (the buttons are disabled), a second recorder
  engine, and a recording left running when the card unmounts or is answered.
- The results total comes from the server's score, so skipped cards are left out (D9).
- `LIVE_DIMENSIONS` changed in its own task, with every badge expectation it moved.
- Speaking types are filtered out of the tiers when speaking is off (D3), rather than made
  ineligible.
- `SpeechTranscriber` is `(request: { system, audio, mimeType, schema }) => raw JSON text`
  (`LlmAudioRequest`), not `{ audio, mimeType, language } => transcript`; the instruction and the
  parsing live in `domain/speech.ts`.
- The eval's `ru-luk` (Milena saying "лук") is heard as "ОК" on every run and is kept failing
  honestly: 25 of 26 clips pass.
- A skipped card is in neither the practised list nor the session's progress snapshot (D7): only
  answers that are not `skipped` count a sense as practised.
- The card's banner uses the verdict the server recorded, carried in the answer
  (`{ heard, verdict }`); the app never re-judges a transcript. `speak-heard` shows only for an
  `alternative`.
- A refused microphone shows the `אין גישה למיקרופון` line once, above whatever card is current,
  for the rest of the session (D7), not only on a typed say-the-translation form.
- The speech upload aborts after 15 s (`SPEECH_UPLOAD_TIMEOUT_MS`), so a stall becomes the
  "couldn't check" notice.
- A recorder that fails to start shows the same "couldn't check" notice rather than a dead button;
  a recorder step that throws restores the iOS audio mode and releases the engine; a tap while a
  recording is stopping is ignored; a permission read that throws means "cannot record" rather
  than failing session creation.
- `speech_judged` carries `transcribed` and omits `transcribe_ms` when the clip was too short for
  a model call, and is logged before the answer is recorded, so a paid transcription is always
  logged.

## 2. Changes

### `packages/core`

- `api/schemas.ts`:
  - `ReadAloudQuestion`: `id`, `type`, `vocab_term_id`, `question` (the form), `meaning`.
  - `SayTranslationQuestion`: `id`, `type`, `vocab_term_id`, `question` (the Hebrew),
    `part_of_speech`, `answer`, `lemma`, `alternatives`.
  - `NextStepRequestSchema` gains `{ user_id, question_id, pass: 'skip' | 'show_answer' }`.
  - `SpokenVerdictSchema`: `understood`, `alternative`, `gave_up`, `skipped`.
    `AnswerRecord.verdict` takes a typed or a spoken verdict.
  - `SpeechAnswerRequestSchema`: `user_id`, `question_id`, `mime_type` (`audio/aac`, `audio/mp4`,
    `audio/webm`), `audio` (at most 270 000 characters). `SpeechAnswerResponseSchema`: `heard`,
    `verdict` (`understood`, `alternative`, `unheard`), `next` (a `NextStepResponse`, present
    unless `unheard`).
  - `CreateSessionRequestSchema` gains `speaking: z.boolean().optional()`.
- `domain/spoken.ts`, new: `judgeSpoken(target, heard)` (D6). `typed.ts` exports the normalising
  and the diacritic folding it already has.
- `domain/quiz.ts`: `AnswerInput` gains `{ heard }`, which only the server builds, and `{ pass }`.
  `answerFits`: a read-aloud card takes `heard` or `pass: 'skip'`; a say-the-translation card
  takes `heard`, either `pass`, or `text`. `evaluate` follows D5 and D6. `score` and `missed` leave
  skipped cards out (D9). `rightAnswer` and `missed` cover both types.
- `domain/progress.ts`: `LIVE_DIMENSIONS` is all five (D11).

### Server

- **Migration 0017** (`0017_speaking_cards.sql`; the next free number on master, not 0018). `questions_type_known` admits `read_aloud` and `say_translation`.
  `questions_shape_valid` gains `read_aloud`, with a prompt and nothing else, as `dictation`; and
  `say_translation`, with a prompt and alternatives, as `typed_translation`.
  `answers_verdict_known` gains `understood`, `gave_up` and `skipped`. Every existing row passes
  unchanged.
- `domain/session.ts`: the tiers gain the two types (D3). `eligibleTypes(pick, { listening,
  speaking })`.
- `domain/progress.ts`: `Evidence.cap` replaces `capped`, and the day's cap rule follows D10.
  `evidenceFor` covers D10's table.
- `domain/distractors.ts`: `taskFor` gives `typed` for `say_translation` and none for
  `read_aloud`.
- `domain/jobs.ts`: the prepare-session payload gains `speaking`, default false.
- `services/speech.ts`, new: the `SpeechTranscriber` type (D13).
- `services/sessions.ts`: `createNextSession(enrollmentId, { listening, speaking })` puts the flag
  in the payload. `answerBySpeech(sessionId, input)` follows D5 and logs `speech_judged`.
- `providers/gemini.ts`: `createGeminiTranscriber` (D13).
- `config.ts`: `speechTimeoutMs`, from `SPEECH_TIMEOUT_MS`, default 8 000.
- `composition.ts`: wires the transcriber into the session service.
- `routes/sessions.ts`: the speech route through `createRoute`, with the body limit. Its outcomes
  map as next-step's do (a question that is not current is 409, a card that is not a speaking card
  is 400 `AnswerKindMismatch`), and `LlmUnavailable` maps to 502 as in `routes/translations.ts`.
  Next-step's `pass` body, and the create body's `speaking`.
- `repo/progress.ts`: `findSessionEvidence` reads the new verdicts.
- ADR 0002: R1 names `expo-file-system` beside `expo-audio`, and its detection command and
  `scripts/check-adr-0002-di-with-closures.sh` change together. A planted import must make the
  check fire before it counts (CLAUDE.md). R6's list gains `createGeminiTranscriber` and
  `createRecorder`.

### Mobile

- `src/recording.ts`, new (D12).
- `src/hooks/useRecording.tsx`, new: `RecordingProvider`, exposing `canRecord()`, the permission
  state, `start()` and `stop()`.
- `package.json`: `expo-file-system` at `~57.0.5` (D12), installed with npm at that range, since
  `npx expo install` refuses to run under this npm.
- `src/app/_layout.tsx`: imports what the recorder needs from `expo-audio` and `expo-file-system`,
  builds it, and wraps the tree in `RecordingProvider`.
- `src/components/SpeakingCardView.tsx`, new: the microphone button, the states of D7, its
  banners and its buttons.
- `src/hooks/useSession.tsx`: `submitSpeech(clip)`, `pass(kind)`, and `speakingOff` for the
  session, which passes read-aloud cards when on (D8).
- `src/hooks/useNextSession.tsx`: sends `speaking: canRecord()`.
- The API client: `answerBySpeech`.
- `src/app/session.tsx`: the two cases. A say-the-translation card renders `TypedAnswerView` when
  speaking is off.
- `feedback.ts`, `strings.ts`: D7's instructions, banners and buttons.

### Eval

- `tests/eval/audio/`, new: AAC in ADTS fixtures (Android's format), 16 kHz mono, made with macOS
  `say` (Alice for Italian, Milena for Russian, Samantha for English), each with 0.6 s of silence
  before and after the word (`say "[[slnc 600]] gatto [[slnc 600]]"`), as a real recording has
  (D12). As built: 8 Italian, 6 Russian and 6 English said right, and two per language where a
  different word is said (26 clips). The command that makes a fixture is in `cases.ts`, so a
  case can be added.
- `cases.ts`: `TranscriptionCase` (`file`, `language`, `target`, `expect: 'understood' | 'unheard'`).
- `run.ts`: tier 1, every response parses and `heard` is a string. Tier 2, `judgeSpoken` of what
  was heard matches `expect`. It is reported as its own tier 2 line, held to the same
  `TIER2_THRESHOLD`.

---

## 3. Testing

### Unit

- **core:**
  - `judgeSpoken`: diacritics folded and the breve kept; an article or a filler word around the
    target; a phrase found as a run of words, and not found when its words are apart or out of
    order; read aloud refuses the lemma; say the translation takes the lemma, and an alternative
    gives `alternative`; one letter off is `unheard`; empty is `unheard`.
  - `evaluate` and `answerFits` for `heard`, `pass` and `text` on each type; `score` and `missed`
    leave skipped cards out; the union parses both shapes.
- **server domain:**
  - the planner: speaking on and off; a four-word phrase can be a speaking card and a five-word
    item never is; ordinals 0–3 show every
    type; two cards in a row never share a type, over sizes 1–10 with speaking on;
  - `evidenceFor`: every row of D10;
  - the cap: read aloud alone stops at 2; read aloud and say the translation on one day are
    uncapped; reverse choice alone still stops at 3.
- **server services (fakes):** `answerBySpeech` writes nothing when not understood; steps and
  returns `next` when understood; does not call the transcriber on a replay, nor for a question
  that is not current or not a speaking card; turns a transcriber failure into `LlmUnavailable`;
  logs `speech_judged` with the fake clock's duration. `createNextSession` puts `speaking` in the
  payload.
- **provider (fake fetch):** the request holds the audio as `inlineData`, the thinking setting and
  the marker; `heard` is parsed; an empty candidate is the empty string; the timeout is
  `LlmUnavailable`.
- **mobile:** `createRecorder` with a fake engine: on iOS the mode is set before recording and
  cleared after; recording stops at five seconds; the permission states give `canRecord`. The
  session hook with "can't speak now": a say-the-translation card is typed, and a read-aloud card
  is passed.

### Integration (real Postgres)

- the migration keeps every existing row, and the new shape checks refuse a row of the wrong
  shape;
- a list session prepared through the queue with speaking on holds the planned types, and its
  say-the-translation questions store alternatives;
- the speech route, with the transcriber stubbed by MockServer: an understood answer stores its
  transcript and verdict; an unheard one leaves the session unchanged; `skip` and `show_answer`
  round-trip; the score leaves skipped cards out;
- the recompute writes back what the live path wrote, for a session holding both types and every
  verdict.

### E2E

- `speaking.spec.ts`. Chromium runs with a fake microphone (`--use-fake-device-for-media-stream`,
  `--use-fake-ui-for-media-stream`) and the microphone permission granted. MockServer answers the
  transcription by its marker, one shot at a time, in order. The planner is a pure function of
  the ordinal (phase 24 D3), so the spec plays the sessions whose plans hold the speaking cards
  where it needs them:
  - a read-aloud card: the first attempt is heard as `gato`, the card says it did not understand
    and shows the speaker; trying again is heard as `gatto`, and the card says it understood;
  - a say-the-translation card, understood;
  - "can't speak now": the next say-the-translation card is typed and accepted, a read-aloud card
    is passed, and the results' total leaves it out.

  The word's page then shows **דיבור** above "not practised".
- The existing specs answer speaking cards through `cards.ts` with "can't speak now", which needs
  no microphone, and expect the five-dimension badge.

### Eval

The transcription cases (§2), run against the real model until they pass reliably. A failing case
changes the instruction, never the threshold.

---

## POC findings

Run on 2026-10-07, before any plan, to test D1's assumptions. Two steps:

- **A desk test.** 24 clips made with macOS `say`: 20 words said right, in Italian, Russian and
  English, and 4 where another word is said. Each clip was sent in four formats to five models
  with the instruction in D13, from a scratch script.
- **A phone test.** A throwaway screen recorded in Expo Go on Victor's Android phone and uploaded
  to a scratch server, which called Gemini. Victor said 14 Italian words and phrases.

The screen is on branch `poc-25-speaking`, which is never merged. The scripts were not kept.

| Question | Answer |
|---|---|
| Does a blind transcriber hear single words? | Yes, once a clip has silence around the word: 24 of 24 on `gemini-2.5-flash`, with the wrong words reported as said (`gato`, `люк`). Without that silence, 18 of 24 (D12). On the phone, 14 of 14. |
| Phrases? | Every phrase Victor said came back exactly (`per favore`, `caffè con cornetto`, `grazie mille`), so phrases moved in (D3). |
| Does Gemini take each platform's format as it is? | Yes: AAC (ADTS), AAC in M4A as `audio/mp4`, WAV, and Chrome's WebM (D12). |
| How long is the wait? | 1.5–2.0 s for the model call, whatever the model or format; about 1.7–2.0 s after tapping stop on the phone. Thinking off saves about 0.3 s (D1, D13). |
| Does a newer model do better? | No. 3.5, 3.6 and 3.8 Flash and 3.1 Flash-Lite were no more accurate; 3.8 was slower (D13). |
| Does recording work in Expo Go without a hook? | Yes, with the class picked per platform (D12). |
| Can the app read the clip for upload? | On Android only through `expo-file-system`: `fetch(file://)` with `FileReader` uploaded 15 bytes (D12). |
| Does a speaker button still sound after recording? | Not checked on iOS, where the risk is (§ Risks). |

## Build order

One PR. It changes no existing prompt. The only new model call is the transcriber, which has its
own cases.

The feasibility step this list once began with is done: § POC findings.

1. Core: the union members, `judgeSpoken`, `pass`, `score` and `missed`, the verdicts,
   `LIVE_DIMENSIONS`.
2. Server domain: the tiers and eligibility, evidence and the cap.
3. The transcriber: contract, provider, config, composition.
4. Migration 0017, the repositories, `answerBySpeech`, the routes.
5. Mobile: the recorder, the card, "can't speak now", the flag.
6. Eval fixtures and cases, run against the real model.
7. Integration and e2e.

## Risks

- **A single word out of context is hard to transcribe.** Short words and homophones (Russian
  `лук`, Italian `è` and `e`) may come back as another word. Folding diacritics covers `è`; the
  eval measures the rest on clean audio; Victor's use decides (D1's switch signal).
- **Synthetic fixtures are not a learner's accent.** The eval proves the path and the instruction,
  not accuracy for Victor's voice. His own recordings can become cases later.
- **The wait is about two seconds,** measured (D1). No setting within this approach cuts it much:
  the floor is the model processing audio. The levers, if Victor's use says it is too long: a
  dedicated speech-to-text service, then recognition on the device (D1's switch signal).
- **A clipped recording.** A learner who taps stop the instant the word ends may cut its tail, and
  clips with no silence transcribe badly (D12). If "not understood" is common for words said
  right, keep recording for 300 ms after the tap.
- **iOS is untested on a device.** The POC ran on Victor's Android phone and in Chromium. The iOS
  audio mode (D12) is unit-tested with a fake engine only. If it is not restored after recording,
  speech from a speaker button plays quietly from the earpiece.
- **Badges drop once** (D11), by at most one level. Announced in the PR.
- **Over-credit from several words said** (D6, low confidence). If badges climb on say the
  translation in a way Victor does not trust, require the transcript to be the target alone.
- **Unauthenticated spending.** Anyone holding a session id can upload clips against its open
  speaking card. The bounds in D13 limit each call, not their number; a lookup has the same
  exposure today, and ADR 0005 accepts it.
- **Background audio.** With `mixWithOthers`, music the learner is playing may be in the clip and
  confuse the transcriber. The transcript on the card will show it.
