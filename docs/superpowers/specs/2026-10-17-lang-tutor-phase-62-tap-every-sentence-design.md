# Phase 62 — Tap the words on every sentence card

- **Status:** approved by Victor on 2026-10-17 ("Yes. Continue till PR", after the builder
  check's two questions). Implemented inline on branch `phase-62-tap-every-sentence`.
- **Date:** 2026-10-17
- **Source:** `drafts/2026-10-17-tap-words-every-sentence-card-one-pager.md` (main checkout), and the
  brainstorming that followed it on 2026-10-17, which worked from mockups of every card before and
  after (`.superpowers/brainstorm/3818-1792262029/content/`, main checkout, gitignored).
- **Builds on:** phase 59 (short translate sentences from the learner's words, the word map, taps and
  what they cost), phase 59c (a tapped word's translation under it), phase 34 (context sentences on
  word cards), phase 27 (the sentence cards and their generation).
- **Touches:** the batch's `sentence` task and the context call's `target` task and their
  validation, the question's stored and served shape, the next-step request, the session service's
  grading of taps, the app's sentence and word cards, the card instructions, prompt evals, e2e.

---

## Goal

Phase 59 made the translate-sentence card one Victor can mostly build: a short sentence from his
own words, and a tap on any word he can't recall. Every other card that shows a sentence still
shows one written freely from everyday Italian, which he was never taught, and offers no way to
look a word up. On those cards he guesses or gives up over the words around the target, so the
card tests the sentence more than the word. And once the card is answered, he still doesn't fully
understand the sentence he just read, which is a chance to learn from its context that is lost.

There is a second confusion, on the word cards: they show a word and an example sentence, and the
instruction does not say which of the two to translate.

This phase gives every in-scope sentence card phase 59's sentence and taps. After answering, it
shows each word's translation and the whole sentence's. And every sentence card's instruction says
what to translate: the word, or the whole sentence.

**Done means** (Victor):

1. On Victor's phone: he finishes sentence cards without giving up over unknown words.
2. In his local testing data: taps are recorded on every in-scope card type, and tapped list words
   take a miss.
3. After answering, every in-scope card shows each word's translation and the whole sentence's
   translation.
4. Every sentence card's instruction says whether to translate the word or the whole sentence
   (D7).
5. Automated tests and the prompt evals prove it works as designed (§2), and `npm test`,
   `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass.

## Scope

**In-scope cards**:

| Card | Sentence shown | A tap shows |
|---|---|---|
| `cloze_choice` | Italian, with a gap | Hebrew |
| `cloze_typed` | Italian, with a gap | Hebrew |
| `sentence_translation` | Hebrew | Italian |
| `multiple_choice` | Italian context line | Hebrew |
| `typed_meaning` | Italian context line | Hebrew |
| `new_meaning` | Italian context line | Hebrew |

**In:**

- On all six in-scope cards, the sentence is short and built from the learner's words (D1). On
  `sentence_translation` this is unchanged.
- The sentence's words and phrases can be tapped before answering (D3). On `sentence_translation`
  this is unchanged.
- A tap costs what it costs in phase 59 (D4).
- After answering, each word's translation and the whole sentence's translation are shown (D5).
- The instruction wording changes on every sentence card (D7), including the Hebrew-context cards
  below.

**Out** (the one-pager's list, and the talk):

- **The Hebrew-context word cards** (`reverse_choice`, `typed_translation`, `say_translation`). They
  get no taps and no translation, and their sentence is generated as today. Victor's ruling (R1):
  "Hebrew context should not be translated". Only their instruction and the example label change
  (D7).
- **Cards without a sentence:** listen_choice, dictation, matching, letter_tiles, read_aloud, meet.
- **The bots and the day simulation**, which do not model taps.
- **What a tap costs:** phase 59's rules, unchanged.
- **Taps on the learner's own answer.**
- **Audio:** nothing new is spoken or played after answering.
- **Questions already generated and stored:** they are not regenerated. A card without a map works
  as it does today (D3).
- **How answers are judged, and when each card appears in a word's life:** unchanged.

---

## 1. Decisions

### D1. Generation: short, and from the learner's words

Two generators write the new cards' sentences. Both are told phase 59's rule: build the sentence
from the learner's practised words as much as possible, in whatever form each needs, and use other
words only where the sentence cannot do without them, keeping those simple. Both are also told to
keep it short.

- **The batch's `sentence` task** (`domain/distractors.ts`) writes the gap sentences: today
  `cloze_typed`'s and, from this phase, `cloze_choice`'s too (below).
- **The context call's `target` task** (`domain/context.ts`) writes the Italian context line of
  `multiple_choice`, `typed_meaning` and `new_meaning`, together with its `context_translation`.

The learner's words are phase 59's: practised list entries, most recently reviewed first, capped
at `MAX_LEARNER_WORDS`, leaving out glosses asked in the same session (`findPractisedWords`). They
go in each call's request once.

**Length.** The Italian sentence is 3–6 words (*my call*: Italian spends words on articles where
Hebrew attaches prefixes, so phase 59's 3–5 Hebrew words come out at about one more in Italian). The
evals confirm it. The limit is enforced where today's 3–12 is, on the Italian. `SENTENCE_MAX_WORDS`
is shared with the context call's `explanation` task, which writes the out-of-scope Hebrew lines,
so that task keeps today's limit: the builder splits the constant rather than tightening it for
both.

**When the rules clash** (R5, Victor). With a short list and a short sentence, the new rules can
fight the existing quality rules. The order of priority is:

1. **The sentence points to the word and its sense.** Today's checks stay unchanged: a gap sentence
   points to its word (phase 41's `pointsToWord`), `cloze_choice`'s other words rule out its wrong
   options (the checker's `gap` test), and a context line pins one sense (phase 34's `meaning`
   check).
2. **It is short.**
3. **It uses the learner's words**, as much as it can.

If the evals show the pointing checks dropping at 3–6 words, the builder raises the length limit,
up to 8 words, and never lowers `TIER2_THRESHOLD`.

**`cloze_choice` gets a generated sentence.**

- **Today:** its sentence is the example saved with the learner's lookup (`dict_var_translations`),
  not written per session, so it can't use the learner's words.
- **From this phase:** it is written per session by the batch's `sentence` task, as `cloze_typed`'s
  is.
- **Its wrong options** are written for the generated sentence's gap, as the `gap` task writes them
  today for the saved example's. The checker's `gap` test runs on the generated sentence.
  *Builder's call:* a combined task or a second item per card. Either way it must fit the
  schemas' item caps and be timed at full size.
- **The gap word** takes the form the sentence needs, as `cloze_typed`'s does, and the options
  match that form (*my call*).
- **When generation fails:** "fails" means anything that today degrades or refuses a gap sentence:
  batch validation, the checker's `translate` check, or its `gap` test calling too many options
  right (phase 48). The card is then refused, as a choice card with too few usable options is
  today (R7). It does not fall back to the saved example.

`new_meaning` and the other word cards keep their own fallback (`fallbackContext`). They lose their
map with it.

### D2. Generation: the word map

Every in-scope sentence gets phase 59's word map, extended to Italian sentences.

- **What an entry says:** for each word or phrase of the sentence the card shows, in order, the
  words of its translation that render it, exactly as written there.
- **On the Italian cards:** the shown sentence is Italian and the translation is the Hebrew
  (`cloze_*`'s `translation`, the context line's `context_translation`).
- **On `sentence_translation`:** unchanged (Hebrew → Italian reference).
- **Phrases and empty entries:** as in phase 59, a phrase the translation renders together is one
  entry. *La casa* → *הבית* is one entry. A word rendered by nothing (*è* in *La casa è grande*) has
  an empty translation and can't be tapped.
- **List words:** an entry that renders one of the learner's practised words names it by its key,
  as in phase 59.

Validation is phase 59's D2, applied to the Italian sentence:

- An entry whose translation is not in the translation is dropped.
- An unknown key is stripped.
- The target's entry is the span the card's mark already gives: the gap on cloze, and the context
  line's `mark` on word cards.
- A bad map never refuses the card.

One rule is added for word cards. There the answer is the target's translation (*אחר כך* for
*poi*), so any other entry whose translation contains the target's translation is dropped. That
way a free tap can never show the answer (*my call*, phase 59's rule for its gap).

*Builder's call:* where the map is asked.

- **Phase 59's R6** put it on the context call's `mark` task, not the batch, because the batch's
  schema once hung on new fields (memory: optional strings in a Gemini schema).
- **The gap sentences come from the batch.** Their map can be asked of a `mark`-like item in the
  context call, or of the batch.
- **The context line already comes from the context call.** Its map belongs on its `target` item.
- **The request must be timed at full size** (memory: thinking budget timeouts).

### D3. Before answering: the taps

On an in-scope card that has a map, every entry with a translation can be tapped before the answer
is final, except the target. Phase 59 and 59c's behaviour is unchanged:

- A tap shows the translation under the word and keeps it there until the card ends.
- A second tap on the same word does nothing.
- The tappable words have a dotted underline, and a tapped word has a solid primary underline.
- Each word keeps an empty line under it from the start, so a tap moves nothing.

**The target is never tappable on the new cards.** On cloze it is the gap, so there is nothing to
tap. On word cards it is the question itself, and its translation is the answer. On
`sentence_translation` a tap on the target stays phase 56's help, as today.

- **The tap hint line:** an Italian sentence takes "הקישו על מילה כדי לראות אותה בעברית". It
  mirrors the existing Hebrew-sentence hint, which stays on `sentence_translation`.
- **The word cards' context line:** today it is small and muted. It becomes full-size text that can
  be tapped.
- **`cloze_typed`'s hint** ("רמז: הצגת המשפט בעברית") stays as it is (*my call*).
- **A card with no map** (stored before this phase, or a fallback sentence) has nothing tappable on
  the new cards, and shows no hint line. On `sentence_translation`, only the target is tappable, as
  today.

### D4. What a tap costs

This is phase 59's D4 and R5, now on every in-scope card, with one change of skill (R6):

- **A tap on a practised list word** writes a miss on that word, once per word per card, whatever
  the card's verdict. It reaches memory and progress at the session's end, and not the session
  score or the missed list. Which skill the miss counts against depends on the direction of the
  tap:
  - **On the Italian cards** (cloze and the three Italian-context word cards), the tap shows the
    Hebrew, so it is a failure to *recognise* the word. It writes **written receptive** Again, the
    grade a wrong `multiple_choice` writes.
  - **On `sentence_translation`**, the tap shows the Italian, so it stays a failure to *produce*
    the word: written productive Again, as today.

  Today `tappedMisses` treats every tap as `sentence_translation`. The card type, or the tap's
  direction, has to reach it.
- **Any other tap** is free.
- **The target** can't be tapped on the new cards (D3). On `sentence_translation` it is help, as
  today.

Taps belong to the card, not the try (phase 59). A second try on `cloze_typed` sends every tap so
far, and still writes each list word's miss once.

### D5. After answering: every word, and the whole sentence

When the card's answer is final (the banner shows: right, wrong or given up), the card shows:

- **under every word that has a map entry, its translation.** The words the learner tapped keep
  their primary colour, the target's translation is bold in the text colour, and every other one
  is muted (*my call*, from the mockups: the words he had to look up stand out).
- **the whole sentence's translation:**
  - **On cloze:** the Hebrew line shown today.
  - **On `sentence_translation`:** "תרגום לדוגמה" with the reference, as today.
  - **On the word cards:** a new line "המשפט בעברית:" with `context_translation`, which the app
    has never received.

A first wrong try that leads to a second try is not final, so the per-word translations wait until
the card ends (*my call*: the second try would otherwise be answered with every word translated).
Phase 38's Hebrew line, which `cloze_typed` deliberately shows during a second try
(`showsSentenceTranslation`), stays as it is. A card with
no map shows only the whole-sentence line, where it has one. A gap word shown filled in after
answering takes its translation like any other word.

### D6. The wire and recording

- **`tapped` travels on every in-scope card.**
  - `cloze_choice`, `multiple_choice` and `new_meaning` answer through `NextStepRequestSchema`'s
    `option_index` shape, and `cloze_typed` through its `text` shape. Both shapes gain the optional
    `tapped` that `JudgedAnswerRequestSchema` already has (`TappedSchema`).
  - `typed_meaning` is judged, so it already carries the field, and the server starts reading it
    for that type.
  - `tapped` is ignored on out-of-scope types. It is optional, so `API_LEVEL` is unchanged
    (ADR 0012) and the app ships after the server.
- **A give-up carries its taps** (phase 59's R7). "הצגת התשובה" on `cloze_typed` and
  `typed_meaning` sends the taps made so far.
- **Served with the question:** `words` for the in-scope types. For the word cards, also the
  context line's translation, which today only the judge reads.
  - **Today's pattern:** `cloze_choice` serves its `translation` with the question, and the app
    holds it back until answered.
  - *Builder's call:* whether the word cards follow that pattern or receive the translation with
    the answer's response.
  - **Never served:** gloss ids.
- **Storage:** taps are stored in `answer_taps` as for `sentence_translation`, and the map in
  `questions.words`. The log line for a next-step answer carries the tap count and the list words
  that took a miss, as `answer_judged` does.
- **A replayed answer** writes no second miss.

### D7. Say what to translate

Victor's ruling (R2): every sentence card's instruction names what is translated, because a word
card that shows an example sentence leaves it unclear. Approved wording:

| Card | Today | New |
|---|---|---|
| `sentence_translation` | תרגמו את המשפט ל**איטלקית** | תרגמו את **כל המשפט** ל**איטלקית** |
| `multiple_choice` | מה הפירוש? | תרגמו את **המילה** לעברית |
| `typed_meaning` | כתבו את הפירוש ב**עברית** | תרגמו את **המילה** ל**עברית** |
| `new_meaning` (its question line) | מה עוד זה אומר? | מה עוד **המילה** אומרת? |
| `reverse_choice` | איך אומרים באיטלקית? | תרגמו את **המילה** לאיטלקית |
| `typed_translation` | כתבו את המילה ב**איטלקית** | תרגמו את **המילה** ל**איטלקית** |
| `say_translation` | אמרו באיטלקית | אמרו את **המילה** באיטלקית |
| `cloze_choice`, `cloze_typed` | unchanged | unchanged: they already say "the missing word" |

Bold marks the emphasis, as the existing strings bold the language. *Builder's call:* whether the
emphasis on המילה / כל המשפט is drawn bold or only the language stays bold, as today. Victor
approved the wording, not the weight.

On all six word cards, including the out-of-scope Hebrew-context ones, the context line gets a small
muted label above it, "משפט לדוגמה:", so it reads as an example and not the thing to translate. The
strings live in `apps/mobile/src/strings.ts`, and the UI is Hebrew only.

---

## 2. Testing

- **Domain:**
  - The `sentence` and `target` tasks carry the practised words and the 3–6 word length.
  - A 7-word Italian sentence is refused.
  - The `explanation` task keeps 3–12.
  - The Italian map's validation drops a bad entry, strips an unknown key, drops a free entry that
    contains a word card's answer, and never refuses the card.
- **Core / server (integration):**
  - A next-step answer with `tapped` on each in-scope type stores the taps.
  - A tapped practised word gets its miss on its own gloss, once, whatever the verdict.
  - A free tap grades nothing.
  - `tapped` on an out-of-scope type is ignored.
  - A replay writes no second miss.
  - `cloze_choice` is generated per session and falls back to the saved example without a map.
  - A stored question without a map is served and answered as today.
- **App:**
  - The tappable words follow the map, and the target is never tappable on the new cards.
  - A tap shows the exact translation.
  - Every word's translation and the whole-sentence line appear only once the answer is final, and
    never between tries.
  - The request body carries `tapped` in order.
  - Each instruction reads as in D7, and the example label shows on all six word cards.
- **Prompt evals:**
  - The `sentence` and `target` cases gain a learner list (Victor's real size).
  - Each sentence is scored for length (3–6 Italian words) and for the share of its content words
    from the list, against a threshold set from the first runs.
  - Diff the CI eval report against master per row: a rule on one task bleeds into others in the
    same call, and the `explanation` and `translate` rows must not move.
- **e2e:** on a cloze spec and a multiple-choice spec:
  - tap a word and see its translation;
  - answer, then see every word's translation and the whole sentence;
  - check the body sent.

  The instruction strings are checked on the specs that already read them.
- **Bots and the day simulation:** unchanged. They send no `tapped`.

---

## Rulings

- **R1 (Victor, brainstorming).** The word cards with an Italian context line are in. The ones with
  a Hebrew context line are out: "Hebrew context should not be translated."
- **R2 (Victor, brainstorming).** Instructions say "translate the word" or "translate the whole
  sentence", because an example sentence beside a word is confusing. He approved the wording in D7,
  and that the Hebrew-context cards get it too.
- **R3 (Victor, one-pager).** After answering, every word's translation is unveiled automatically,
  plus the whole sentence's translation, "which gives additional effect of fully understanding the
  context".
- **R4 (Victor, one-pager).** Sentences follow translate sentence's principle: short, and from the
  learner's words.
- **R5 (Victor, after the builder check).** When short and from the learner's words clash with a
  sentence pointing to its word and sense, the pointing wins, then short, then the learner's words.
  The length may go up to 8 words if the evals need it, and the eval thresholds never drop.
- **R6 (Victor, after the builder check).** A tap on an Italian sentence (Italian shown, Hebrew
  revealed) is a recognition miss: written receptive Again. On translate sentence it stays a
  production miss.
- **R7 (planning).** A `cloze_choice` whose generated sentence fails is refused (phase 48), and does
  not fall back to the saved example. A fallback would need a second batch item per card for the
  saved example's options, and the batch schema caps items at ten, a whole session, and once hung
  on a change.
