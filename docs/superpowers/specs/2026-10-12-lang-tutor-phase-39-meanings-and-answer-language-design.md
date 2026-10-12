# Phase 39 — One meaning at a time, answers in the right language

- **Status:** Designed on 2026-10-12 with Victor, section by section, through section 4 (answer
  language). Then he said "go till PR, subagents": section 5 (testing and rollout) and the rulings
  marked *(self-approved)* were decided here with a recommendation (CLAUDE.md, *Continue till PR*).
- **Date:** 2026-10-12
- **Source:** `drafts/2026-10-12-meanings-and-answer-language-one-pager.md` (scope, and the
  analysis of lane 0's sessions of 2026-10-11), plus the brainstorming conversation. `drafts/` is
  gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 31 (glosses, ADR 0011), phase 34 (PR #134: context sentences, known-right
  options, the second try, `API_LEVEL` 2), phase 35 (memory, the picker) and phase 37 (PR #136:
  returns, the passes of `chooseWords`).
- **Touches:** a new pure module (`domain/glossFamilies.ts`) and a new core module
  (`packages/core/src/domain/script.ts`); `choose.ts`, `plan.ts`, `chooseConstants.ts`; the session
  service (creation, the prepare job, answering); two repo reads and a new repo; migration 0030
  (three tables, one column, one type); a new question type on the wire; `API_LEVEL` 3; the
  session screen and the typed card; the bots' player; e2e specs.

---

## Goal

On 2026-10-11 two things went wrong in Victor's sessions:

- **Several meanings of one English word in one session.** "degree" came back twice per session,
  each meaning answered with the other's. One session asked "blow up" three times, twice as
  identical dictations.
- **Answers in the wrong language.** Dictation was answered in Hebrew in 4 of 22 cards. Each was
  graded wrong, and each wrong grade brought the word back.

After this phase:

- A learner learns **one meaning of an English word at a time**. The next meaning waits until the
  current one is known in every skill the phone has on. It arrives as a card of its own, "pick up
  means להרים. What else does it mean?", so the learner sees it as a new meaning of a familiar word.
- No session asks two meanings of one English word.
- A typed answer in the wrong alphabet is never graded. The card asks again, in the right language,
  keeping the text.
- Every typed card names its answer language in bold: "כתבו את המילה ב**אנגלית**".

**Done means:**

1. No session asks two glosses of one family (D1, D5).
2. A family's next meaning is first asked only once every earlier one has been known (D2, D3), and
   that first card is `new_meaning` (D6).
3. A wrong-alphabet answer is never graded and never brings the word back; the card asks again and
   keeps the text (D7, D8, D10).
4. Every typed card's instruction shows its answer language in bold (D9).

Checked by the day tests (D12), a test per typed card, and a re-analysis of the next real sessions.
`npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:**
- gloss families, known meanings, one meaning in learning per family (D1–D4);
- at most one gloss of a family per session, returns first (D5);
- the `new_meaning` card (D6);
- no grading of a wrong-alphabet answer on any typed card, typed meaning included (D7, D8, D10);
- the answer language in bold on every typed card (D9).

**Out** (the one-pager's, unchanged):
- the new-word limit on heavy days;
- the judge's strictness;
- dictionary data fixes, among them sentence cards that inflect a word into a form the dictionary
  does not hold (D1);
- card ambiguity (phase 34's);
- a wrong language in the same alphabet (an English speaker learning Italian);
- spoken answers in the wrong language;
- learner settings.

---

## D1. Gloss families

A **gloss family** is a set of a learner's saved glosses that a session could show with the same
English word. Two saved glosses of one enrollment are in one family when:

1. **Same lexeme.** They share `dict_glosses.lexeme_id`: the five meanings of "blow up".
2. **Homographs.** Their lexemes, of one language, share a variant spelling: `dict_variants.form`,
   compared lowercased. "see" has the variant "saw" (`entry_rank` 0), so its glosses join both
   "saw" lexemes' (the tool, `entry_rank` 1, and to cut, 2). The dictionary is shared: "saw"
   became a form of "see" the first time anyone looked up "saw", since a lookup returns every
   reading of a form, ranked.
3. **Transitively, among the enrollment's saved glosses only.** The chain stops at what the learner
   saved, so a family never grows across the whole dictionary.

Membership comes from the dictionary's structure, not from its renderings, so it does not wait on a
render job. A form the dictionary has never seen cannot appear on any card, since a card only shows
dictionary renderings, so it cannot put one spelling on screen with two meanings. When a later lookup
adds the form, the next refresh (D4) merges the families and records the `joined` event.

A word with one saved gloss is not a family. On lane 0 (130 saved glosses), 63 glosses fall in 20
families: from "blow job" (2) to "spring" and "open" (5).

**Why "gloss family", not "word family".** The members are glosses (ADR 0011), and the tables beside
these are `gloss_progress` and `gloss_memory`. "Word family" already means something else in
vocabulary research: a base word with its inflections and derivations (Bauer & Nation 1993), close
to the opposite of this group. "Sibling" is also avoided: phase 31's `findSiblings` means the
reverse, other English words with the same Hebrew key.

## D2. Known, and known once

A gloss is **known** when, for every skill live in the session being created, it has memory with
stability at least `KNOWN_STABILITY` (7 days):

- written receptive, written productive and spelling, always;
- spoken receptive, when the session has listening;
- spoken productive, when the session has speaking and the gloss is `speakable` (one to four words,
  `speakable` in `packages/core/src/domain/spoken.ts`, read on the saved form). A longer phrase never
  gets a speaking card, so without this its family would wait forever.

What 7 means, with the app's FSRS parameters:

| History in a skill | Stability |
|---|---|
| Right the first day | 2.3 |
| Right four times the same day | 2.3 (same-day repeats add nothing) |
| Right on day 0, then hard on day 1 | 5.3 |
| Right on day 0, then right on day 1 | 7.3: known |
| Right on day 0, then right on day 2 | 11.0: known |

So a skill counts as known once it was **remembered right on a later day**, not drilled within one.
`KNOWN_STABILITY` is a named constant in `chooseConstants.ts` for the bots to tune.

**Every skill, not only meaning.** Victor's definition: "I know 'pick up' means high stability in
all skills. I can recall, pronounce etc. Only then I am ready to learn an additional gloss." He
accepted the slower pace that comes with it. Speaking gets one card per session, so a family's next
meaning waits a week or two per meaning, and a five-meaning word reaches its last meaning months
later.

**Known once, known for the family.** The first time a refresh (D4) sees a gloss known, it records
`known_at`. From then on the gloss counts as known for its family, whatever its memory says. A later
lapse is handled by ordinary review: the miss owes a return (phase 37 D1), the return claims the
family's slot (D5), and the word is relearned. The meaning being learned keeps its place.

*Why.* With every skill counted, a lapse is common: a typo grades spelling Again and drops its
stability to about 1. Re-evaluating "known" from memory each time would pause the newer meaning
mid-learning until spelling recovers, a few days, and the newer meaning would keep stopping and
starting.

*Cost.* `known_at` makes the tables (D4) an input for that one fact, not only a record. If those
rows were lost, the next refresh would treat lapsed meanings as never known. That is the stricter
behaviour, so the failure is safe.

*A consequence.* "Live" is the session's. A gloss can first reach `known` in a session with speaking
off, where speaking is not required; `known_at` then holds in later sessions with speaking on.

## D3. The current meaning, waiting, introductions

`apps/server/src/domain/glossFamilies.ts`, pure (ADR 0001 R3):

```ts
/** One saved gloss as the families rule reads it. */
export type FamilyGloss = {
  glossId: string;
  lexemeId: string;
  /** Its Hebrew meaning: what an intro card lists as known. */
  key: string;
  savedAt: string;
  /** Every variant spelling of its lexeme, lowercased (D1). */
  forms: readonly string[];
  /** The dictionary's order of this meaning: its saved variant's entry_rank, then the lowest
   *  rank among its renderings on that variant. Lower is more common. */
  order: readonly [number, number];
  /** One to four words: it can ever get speaking memory (D2). */
  speakable: boolean;
  /** When a refresh first saw it known (D2, D4); null if never. */
  knownAt: string | null;
};

export type FamilyInput = {
  saved: readonly FamilyGloss[];
  memory: readonly { glossId: string; dimension: Dimension; state: MemoryState }[];
  /** The session's live skills, as chooseWords computes them. */
  live: readonly Dimension[];
};

export type GlossFamily = {
  glossIds: string[];                  // in family order (below)
  label: string;                       // its members' lemmas, sorted, joined by " / "
};

export type FamilyState = 'known' | 'current' | 'waiting';

export type Families = {
  families: GlossFamily[];             // only those of two or more glosses
  familyOf: ReadonlyMap<string, number>;   // gloss → index into families
  state: ReadonlyMap<string, FamilyState>; // every member of a family
  /** Members newly known in this refresh: the refresh records their known_at (D4). */
  newlyKnown: ReadonlySet<string>;
  /** A current gloss never asked, in a family with a known gloss → the known glosses' keys, in
   *  family order. Its first card is new_meaning (D6). */
  introductions: ReadonlyMap<string, string[]>;
  /** Per member, what decided its state: the live skills and its stability in each. */
  evidence: ReadonlyMap<string, { live: Dimension[]; stability: Partial<Record<Dimension, number>> }>;
};

export function glossFamilies(input: FamilyInput): Families;
```

The rule, for each family of two or more glosses:

1. **Known:** `knownAt` is set, or the gloss is known by D2 now (then it is in `newlyKnown`).
2. **Family order:** glosses practised (any memory row) before glosses never asked; then `order`;
   then `savedAt`; then `glossId`.
3. **Current:** the first gloss in family order that is not known. A family whose glosses are all
   known has none.
4. **Waiting:** every other gloss that is not known.
5. **Introductions:** a current gloss with no memory at all, in a family with at least one known
   gloss, maps to the known glosses' `key`s, in family order.

Rulings this encodes:
- **Already-met meanings wait too.** degree→מעלה and degree→מידה were met before this phase and are
  not known; while degree→תואר is current, they wait. They come back as ordinary cards when their
  turn comes, not as introductions: `new_meaning` is for a gloss never asked.
- **The first meaning of a word** is introduced as today, as a new word.
- **A lapsed known meaning** stays known (D2). The newer meaning stays current.

On lane 0 today no gloss is known in all five skills, so every family has one current gloss and the
rest wait: **43 glosses wait, 29 of them already practised.** Victor's active list goes from 130
glosses to 87 until the first meanings become known. This is the rule as agreed; reversing it for
already-practised glosses would be a one-line change in rule 4.

## D4. Recording: derive, then record

Nothing decides from stored state except `known_at` (D2). The rule is computed on every session
creation from memory and the dictionary, so it cannot drift from them. In the same transaction, the
result is recorded, so the tables always show what was decided, when, and on what evidence. Victor
asked for tables so that the families can be traced and debugged.

**Migration 0030** (`apps/server/src/db/migrations/0030_gloss_families.sql`; the number shifts if a
sibling phase takes it first, see *Build order*):

```
gloss_families                      one row per family of two or more glosses in an enrollment
  id             text  pk (uuid)
  enrollment_id  text  fk enrollments, on delete cascade
  label          text  not null      its members' lemmas: "blow up", "saw / see"
  created_at     timestamptz not null default now()
  updated_at     timestamptz not null default now()

gloss_family_members                one row per saved gloss in such a family
  enrollment_id  text  ┐ pk; fk → vocabulary_entries (enrollment_id, gloss_id), on delete cascade
  gloss_id       text  ┘ (gloss_progress's shape, so ADR 0011 holds)
  family_id      text  not null, fk gloss_families, on delete cascade
  state          text  not null, check in ('known', 'current', 'waiting')
  position       integer not null    its place in family order (D3), from 0
  known_at       timestamptz         first seen known (D2); null if never
  since          timestamptz not null  when it entered this state

gloss_family_events                 append-only: every change, and why
  id             text  pk (uuid)
  enrollment_id  text  not null, fk enrollments, on delete cascade
  family_id      text  not null      no fk: the log outlives a dissolved family
  gloss_id       text  not null      no fk: the log outlives an unsaved gloss
  session_id     text  not null      the session whose creation saw the change
  from_state     text                null = joined the family
  to_state       text                null = left it (its family dissolved or split away)
  evidence       jsonb not null      { live: [...], stability: { dimension: S }, known_stability: 7 }
  at             timestamptz not null default now()
  index (enrollment_id, at)
```

ADR 0011 R1 holds: none of the three references `dict_senses` or `dict_var_translations`. R2 does not
apply (it names `vocabulary_entries` and `questions`). `gloss_family_members` reaches the gloss through
its entry, as `gloss_progress` does.

**The refresh**, in `createNextSession` (D5 shows where), through a new `repo/glossFamilies.ts`:

- `load(enrollmentId)`: the stored families and members, `known_at` included.
- The service runs `glossFamilies` with each gloss's stored `known_at`.
- **Family identity.** A computed family keeps the id of the stored family holding most of its
  members; ties go to the older. A computed family with no stored members gets a new id. A stored
  family left with no computed members is deleted. So a merge keeps one id and the others' members
  arrive as `joined`.
- `apply(enrollmentId, sessionId, changes)` writes, for every member whose family, state or position
  changed, its row, and for every change of state or family, one event with that member's evidence.
  `known_at` is written for `newlyKnown`. A refresh that changes nothing writes nothing.
- The session row exists before `apply`, so each event names its session (D5).

An unsaved gloss's member row goes with its entry (the cascade); the log keeps its earlier events.

**Reading it.** The spec's debugging queries, also in the PR body:

```sql
-- Who is waiting on what, per family.
select f.label, m.position, m.state, m.since, m.known_at, g.key
from gloss_family_members m
join gloss_families f on f.id = m.family_id
join dict_glosses g on g.id = m.gloss_id
where m.enrollment_id = '<id>'
order by f.label, m.position;

-- Why a gloss is where it is: its history.
select e.at, e.session_id, e.from_state, e.to_state, e.evidence
from gloss_family_events e
where e.enrollment_id = '<id>' and e.gloss_id = '<gloss>'
order by e.at;
```

## D5. Choosing with families

`createNextSession` (`services/sessions.ts`), in order:

1. Reads the saved glosses, memory and levels, as today. `listSavedGlosses` gains `lexemeId`, the saved
   form, and `order` (D3). A new `dict.findLexemeForms({ lexemeIds })` returns every variant spelling
   of those lexemes, lowercased.
2. Reads the stored families (`load`) and computes `glossFamilies` with the session's live skills.
3. Reads today (phase 37), as today.
4. Calls `chooseWords` with `families: { familyOf, waiting }`, where `waiting` is the members in state
   `waiting`.
5. Picks renderings, as today.
6. Inserts the preparing session, then records the refresh (`apply`, D4), then enqueues the job. A
   pick for a gloss in `introductions` carries `known_meanings` (D6).

`chooseWords` (`domain/choose.ts`):

- **A waiting gloss is no candidate.** It gets no class and no pass: not new, due, a return, the
  speaking pick, or extra practice. A return it still owes from before this phase is never asked
  while it waits, and costs nothing: unmade returns do not count toward `RETURNS_PER_DAY`.
- **One slot per family per session.** A candidate's family is a second mark beside its normalised
  Hebrew key (phase 31 D18). `free()`, which every pass already calls, refuses a candidate whose key
  or family is taken.
- **Returns claim first.** Before pass 1, each return, earliest opened first, claims its family when
  it is unclaimed. A claimed family is not free to any other gloss for the whole session; the
  claiming return itself stays free. So no new word, speaking pick or done word takes a family's
  slot ahead of its owed return, and of two meanings owing a return the earlier-opened goes first;
  the other waits a session.
- **Session length.** `n` counts groups joined by either mark, a family or a Hebrew key (union-find),
  instead of distinct keys, so a list of a few large families does not promise more picks than it can
  give.

## D6. The `new_meaning` card

**What it shows** (Hebrew UI, so it reads right to left on the phone):

```
            פירוש חדש למילה שאתם מכירים          ← instruction ("A new meaning for a word you know")

                    pick up                      ← the word, large
              כבר למדתם: להרים                   ← every known meaning ("You already learned: …")

      "She'll pick up the kids at five."          ← the new meaning's example, word marked

                מה עוד זה אומר?                  ← "What else does it mean?"
          [ לאסוף ]          [ לבשל ]
          [ לשבור ]          [ לנגן ]
```

**Wire** (`packages/core/src/api/schemas.ts`), in `QuestionSchema`'s union:

```ts
export const NewMeaningQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('new_meaning'),
  vocab_term_id: z.string(),
  question: z.string(),                // the English form: "pick up"
  known_meanings: z.array(z.string()), // the known meanings, in family order: ["להרים"]
  options: z.array(z.string()),        // the new meaning and three wrong ones
  correct_option: z.number().int(),
  context: ContextSchema.nullable(),   // the new meaning's example, word marked
});
```

**Stored.** A `questions` row of type `new_meaning`, with `options` and `context` stored as a multiple
choice stores them, and a new nullable column `known_meanings text[]` (migration 0030).
`questions_type_known` gains the type; a check keeps `known_meanings` non-null and non-empty on
`new_meaning` and null on every other type; the type's shape check is multiple choice's. The card
records what was shown, so a resumed session draws the same card, and an analysis reads the known
meanings from the question.

**Job payload.** The prepare job's pick gains `known_meanings: z.array(z.string()).optional()`. A job
enqueued before the deploy has none.

**Plan** (`domain/plan.ts`). `PlanPick` gains `knownMeanings?`. A pick with them is always
`new_meaning`: written receptive, rung 1, four options. It is not chosen from `RUNGS`, so it does not
count toward `MAX_PER_TYPE`, as a new word's multiple choice does not. It is never on a matching
board, since a board is made only from multiple-choice picks. Its expected success is a four-option
card's.

**Prepare** (`services/sessions.ts`). One mapping, `generatedAs(type)`, sends a `new_meaning` card
through exactly the multiple-choice paths: its distractor item, its context item, its checker item and
`CHOSEN`'s surviving options. Only the stored row differs: its type, and `known_meanings` from the
payload. No prompt and no model schema changes. Phase 34's known-right list already keeps every
meaning of the word and its homographs out of the wrong options, whether known, current or waiting:
לענות never appears as a wrong option for "pick up".

**Graded.** Exactly as multiple choice: `gradesFor` gives written receptive Good or Again; the level
evidence (`domain/progress.ts`) and `evaluate`/`isChoice` (`packages/core/src/domain/quiz.ts`) treat
it as a choice. Its first answer introduces the gloss, so it owes a return like any new word (phase
37 D1).

**On the phone** (`apps/mobile`):
- `renderQuestion` (`app/session.tsx`) gets the case; its `never` check makes leaving it out a build
  error.
- The view is the multiple-choice view with the sketch's prompt: the instruction, the word, the
  known-meanings line, the context sentence and "מה עוד זה אומר?" above the options. Root test id
  `new-meaning-card`.
- New strings: `questionInstructionNewMeaning`, `knownMeanings(meanings)`, `newMeaningQuestion`.
- The banner after an answer is multiple choice's. The results screen and the missed list treat it
  as a choice card.

**Elsewhere.** The bots' player (`bots/src`) answers it as a choice, and their analysis counts it as a
multiple choice, so the nightly bots do not stall on an unknown type. The e2e card helpers learn its
root test id.

## D7. Answer language: the rule

`packages/core/src/domain/script.ts`, pure, shared by the app and the server, exported from the core
domain index:

```ts
export const SCRIPTS: Record<LanguageCode, 'Latin' | 'Hebrew' | 'Cyrillic'> = {
  en: 'Latin', it: 'Latin', ru: 'Cyrillic', he: 'Hebrew',
};

/** The types a learner answers by typing, and so can type in the wrong alphabet. Letter tiles are
 *  built from given letters and are not among them. */
export type TypedAnswerType =
  'typed_translation' | 'cloze_typed' | 'sentence_translation' | 'dictation' | 'say_translation' | 'typed_meaning';

/** The language a typed card is answered in: the learner's on a typed meaning, the target's on
 *  every other. */
export function answerLanguage(type: TypedAnswerType, target: LanguageCode, learner: LanguageCode): LanguageCode;

/** At least one letter, and none of them in the language's script. Empty text is not a wrong
 *  script: it gives up. */
export function wrongScript(text: string, language: LanguageCode): boolean;
```

- **Mixed answers are judged as today.** "blow up להתפוצץ" in a dictation has Latin letters, so it is
  not a wrong script, and the rule judge grades it. Asking again on any stray letter would block
  real answers: an acronym inside a Hebrew meaning ("DNA"), an English name in a translated sentence.
  The four answers Victor saw (מציצה, ים, מרים, להכשל) were whole Hebrew words.
- **Digits and punctuation are not letters**, so "1990" is never a wrong script.
- **Same-script pairs never trigger.** For an English speaker learning Italian both are Latin; that
  case is Out.
- **Spoken answers are Out.** `say_translation` is covered only in its typed form, when speaking is
  off.

## D8. Asking again, on the phone

The check lives in `TypedAnswerView`, which owns the text and the keyboard. The view gains
`answerLanguage: LanguageCode`; `session.tsx` passes the target language, or the enrollment's learner
language on a typed meaning.

- A submit whose text is a wrong script never reaches `onSubmit`: no request, no banner, no grade.
- The text stays, and the keyboard stays up, because the learner has to switch its language.
- A notice appears under the input: "התשובה צריכה להיות ב**אנגלית**" ("The answer should be in
  **English**"), test id `wrong-script`. It clears as soon as the text changes.
- It applies equally to the phase 34 second try. "Show the answer" sends empty text and gives up as
  today.

The phone never sends a refused try, so a re-analysis of real sessions cannot count how often the
check fired; it can confirm that no wrong-alphabet answer was graded. Sending each refused try only
to log it is not worth a request *(self-approved)*.

## D9. The answer language in bold

The typed cards' instruction strings return three parts instead of one string:

```ts
export type Instruction = { before: string; language: string; after: string };
```

`TypedAnswerView`'s `instruction` prop takes an `Instruction` and draws `language` in bold, inside the
same `Text`. The strings:

| Card | Instruction |
|---|---|
| typed translation, typed say-translation | כתבו את המילה ב**אנגלית** |
| dictation | הקשיבו וכתבו ב**אנגלית** |
| typed cloze | השלימו את המילה החסרה ב**אנגלית** |
| sentence translation | תרגמו ל**אנגלית** |
| typed meaning | כתבו את הפירוש ב**עברית** |

The typed meaning's language name now comes from the enrollment's learner language instead of being
written into the string. The wrong-script notice (D8) is an `Instruction` too. Choice cards and
letter tiles keep their plain strings.

## D10. The server's backstop

- **Domain.** `step` (`apps/server/src/domain/session.ts`) takes `languages: { target, learner }` in
  its options. Its refusal returns a new outcome, `{ status: 'wrong_script' }`, for a text answer to a
  `TypedAnswerType` card whose text is a wrong script in `answerLanguage(...)`. It is checked before
  anything is recorded, the second try included. `{ text, judged }` answers are checked the same way.
- **Service.** `submitAnswer` throws `WrongScript(questionId, language)` (`errors.ts`). `answerJudged`
  checks before the rule verdict and the judge, so no model is called. Each refusal logs
  `answer_wrong_script` with `session_id` and `question_type`.
- **Routes.** `POST …/next-step` and the judged-answer route map `WrongScript` to 422
  `{ error: "the answer is not written in <language>'s alphabet" }`, declared in the OpenAPI document
  (ADR 0003).

Only an app older than API level 3 can reach it, and the update-required screen catches those first.

## D11. API level 3

`API_LEVEL` in `packages/core/src/apiLevel.ts` goes from 2 to 3 in this PR, with a comment naming both
reasons (ADR 0012, *a change that breaks older clients*):
- the `new_meaning` question type, which an older app cannot draw;
- the `wrong_script` refusal of a request an older app would have had graded.

An installed app below level 3 gets the update-required screen, which takes the over-the-air update
(phase 32). Victor's Expo Go reloads from Metro.

## D12. Testing *(self-approved)*

**Unit.**
- **`glossFamilies.ts`:**
  - membership by lexeme; by a shared variant spelling, case-folded; transitively; never through an
    unsaved gloss;
  - known: every live skill at `KNOWN_STABILITY`; listening and speaking only when live; speaking
    only when speakable; `knownAt` holds after a lapse; `newlyKnown` only on first reaching it;
  - family order: practised first, then `order`, then save time, then id;
  - current, waiting, a family all known; introductions only for a never-asked current gloss with a
    known sibling, keys in family order;
  - a one-gloss word is in no family; evidence per member.
- **`choose.ts`:** a waiting gloss is never picked in any pass; one gloss per family per session in
  every pass (reserve, speaking pick, returns, due, expand, not due, deferred, done); returns claim
  first against a new word, the speaking pick and a done word; of two returns in one family the
  earlier-opened is asked; `n` by groups.
- **`plan.ts`:** a pick with known meanings is `new_meaning`; it is not counted toward
  `MAX_PER_TYPE`; it is never on a board.
- **`script.ts`:** each language's script; Hebrew in a Latin answer; Latin in a Hebrew answer;
  Cyrillic; mixed; digits only; empty; `answerLanguage` per type.
- **Grades and evaluation:** `new_meaning` grades as multiple choice; `evaluate` and `isChoice`.
- **`step`:** `wrong_script` on each `TypedAnswerType`, on a first answer and on a second try;
  nothing for empty text; nothing on a choice card.
- **App:** `TypedAnswerView`'s gate (no submit, text kept, notice cleared on change); the bold
  instruction parts; the `new_meaning` view and strings.

**The day tests** (`domain/day.test.ts`).
- The day runner computes `glossFamilies` before each session's `chooseWords`, carrying `known_at`
  from session to session, and plans `known_meanings` picks as `new_meaning`.
- `day.fixture.ts` gains, per saved gloss, an anonymised `lexemeId` (`x001…`) and its lexeme's `forms`
  (`f001…`), so that glosses sharing a lexeme or a spelling keep sharing it. They come from lane 0,
  matched to the fixture's glosses by save time and then gloss id (as `ORDER BY created_at,
  gloss_id`), which reproduces the fixture's key classes; the match is verified on the memory of
  glosses lane 0 has not answered since 2026-10-10. Its `order` and `speakable` come from lane 0
  likewise.
- Every run (lane 0's nine sessions, its twenty, the new learner) adds two outcomes:
  6. no session has two glosses of one family;
  7. no waiting gloss is ever picked.
- A new run, **families over days**: a small list with a five-meaning word, a homograph pair and
  single words, over ten days of six sessions, memory carried day to day. It asserts outcomes 6 and
  7, and that a family's second meaning is first asked only after its first is known, with a
  `new_meaning` card listing the first's meaning.

**Integration** (`apps/server/tests/integration/`).
- `listSavedGlosses`'s new fields and `findLexemeForms`.
- The refresh: rows and events written at session creation; no writes when nothing changed;
  `known_at` kept through a lapse; a merge keeps one family id; unsaving cascades the member row.
- Session creation never picks a waiting gloss, and a pick in `introductions` reaches the job payload
  with `known_meanings`.
- The prepare job stores a `new_meaning` card with its known meanings; the session loads it back on
  the wire.
- `wrong_script`: 422 on `next-step` for a dictation answered in Hebrew, and on the judged route for a
  typed meaning answered in Latin letters, with nothing written and no judge call.
- The migration test covers 0030.

**Bots.** The player answers `new_meaning`; the analysis counts it as a choice.

**e2e** (`e2e/tests/`).
- A `new_meaning` card appears for a saved family with a known gloss (seeded memory through
  `e2e/tests/support/memory.ts`) and is answered.
- A dictation answered in Hebrew shows the notice, keeps the text, and is then answered in English.
- A typed meaning answered in English shows the notice.
- The instruction's language is bold (the inner `Text`'s weight).

No prompt changes, so no eval changes.

## Build order

One PR, one phase. The meanings half (D1–D6) is built first: it lives mostly on the server. The
answer-language half (D7–D10) comes last. Phase 38 (PR #138), which edits the same typed-card files
(`TypedAnswerView`, `strings.ts`, `session.tsx`, `useSession`, `quiz.ts`, `schemas.ts`), merged on
2026-10-12 before this branch's first commit, so this phase builds on it and its migration 0029.
Master is fetched between tasks; if a sibling phase takes 0030 first, this branch's migration is
renumbered (`npx drizzle-kit generate` on the merged schema).

## Left for Victor

After merge, from the main checkout:

```bash
git pull
npm install
npm run db:migrate      # lane 0 gets 0030
# restart lane 0's server (npm run server)
```

Then release as usual. Installed apps below API level 3 see the update screen once and take the
over-the-air update.

**What to expect on lane 0.** The first session after the deploy records 20 families. No gloss is yet
known in all five skills, so in each family one gloss is current and the rest wait: 43 glosses, 29
of them already practised, for example degree→מעלה and degree→מידה behind degree→תואר, and every
"bloody" meaning but מדמם. They come back one by one as the current meanings become known. The
debugging queries in D4 show who waits on what.

## Risks

- **The pace is slow, on purpose.** Every skill at 7 days, with one speaking card per session, holds
  a family's next meaning for a week or two per meaning. `KNOWN_STABILITY` is the knob.
- **Already-practised meanings fade while they wait** (D3). They are relearned when their turn comes,
  as ordinary cards. Exempting them is a one-line change in rule 4 if the cost shows.
- **The bots' numbers move.** Fewer glosses are active, and families serialise their meanings, so
  the weekly numbers will differ from the previous week's for a reason other than the memory model.
- **A sentence card can still inflect a word** into a form the dictionary does not hold ("I saw him"
  on a cloze for ראה), so one spelling could reach the screen with two meanings that way. It is a
  dictionary data fix, Out.

## As built

Rulings made while building go here.
