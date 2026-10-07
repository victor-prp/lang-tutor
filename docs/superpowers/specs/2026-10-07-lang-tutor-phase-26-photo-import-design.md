# Phase 26 — Words from a photo

- **Status:** Designed on 2026-10-07 with Victor, section by section. He scoped the phase in the
  one-pager. In the design he chose a background import over a review the app drives (D1), and
  approved keeping the photo until it is read (D3), one sense per row with an options list (D7),
  where imports live in the app (D13), and every design section. He struck two things: checking
  whether a word is already saved (D7) and handling identical uploads (D12). Every decision is in
  §1 with its reason, so each one can be overturned in review. Those marked **(low confidence)**
  are the ones to read first. Planned in `docs/superpowers/plans/2026-10-07-phase-26-photo-import.md`
  and built on branch `phase-26-photo-import`. Victor asked for the plan to be built and one PR
  opened in one go ("I trust your decisions"). These deviations were found while planning and
  building:
  - **One PR, not two (D15).** Victor asked for one PR. D15's gate still held: the eval ran
    against the real model before any app task began.
  - **The eval photos are synthetic.** Victor's photos were not available. Seven pages were
    rendered in Chromium, printed and in handwriting fonts. They are listed in
    `tests/eval/fixtures/photos/README.md`, where his own photos can join them.
  - **The wire's status adds `saved` and `discarded`,** because `GET` answers any import that
    still exists (D10). The summary's count is `settled_count`, the rows no longer pending,
    rather than `ready_count`.
  - **The repository has no `clearPhoto`.** Every transition clears the photo, and a table check
    enforces it (`photo_imports_photo_only_while_reading`).
  - **Rows store `suggested_sense_id`,** the job's choice, so `photo_import_saved` can count
    changed senses (D14).
  - **The reader drops items that are empty or over 100 characters,** the lookup's own cap. They
    are counted in `photo_read.dropped_count`.
  - **The picker answers a `PickResult`** (`photo`, `cancelled` or `denied`) rather than `null`
    with a `denied` flag.
  - **Mobile logic is tested as a pure module** (`src/photoImports.ts`), because the app has no
    hook tests (D13's "usePhotoImport" tests became `photoImports.test.ts`).
  - **e2e matches model answers by request body** (`expectGeminiMatching`), because row lookups
    run four at a time.
  - **Phase 25 merged mid-build, so the migration is 0018.** Phase 25 (#94) took migration 0017
    while this branch was being built. Master was merged in and `0018_photo_imports` was
    regenerated on top of its snapshot. The provider's vision client is built on phase 25's
    shared `generate()`.
  - **A row change, a save and a discard are serialized.** Review found that a tick racing a save
    could land after the save had read the rows, saving a word the learner had unticked.
    `updateItem`, `save` and `discard` now take the import row with `SELECT … FOR UPDATE` first
    (`findImportForUpdate`). A route test fires an untick and a save at once and checks that the
    outcome is consistent either way. The app also disables Save while a change is in flight.
  - **The service method is `getImport`, not `get`.** ADR 0003's grep for raw Hono verbs matches
    `.get(`. Renaming it (as `SessionService.getSession`) keeps the routes free of an alias
    around the rule.
  - **A row's position is capped at the Postgres integer range,** so an absurd position answers
    400, not 500.
  - **The reader skips crossed-out words by a rule of its own (rule 6).** The eval caught the
    whiteboard's crossed-out `neve` coming back. A sentence added to rule 1 fixed it but broke
    article dropping on the printed page. A separate rule fixed it without regressions.
  - **One match case was wrong in the plan.** `להתייאש` means "to despair", not "give up". The
    case now uses the idiom `להרים ידיים`.
  - **The app's provider keeps each list under its enrollment,** as `useNextSession` does. The
    planned reset on enrollment change swallowed home's first read after a switch or a login
    (child effects run before the provider's).
  - **After save or discard the app uses `router.dismissTo` home,** not `replace`, so no second
    home stacks up. The word cell shows the corrected form when the lookup corrected it.
  - **Home's body is a ScrollView,** to fit the new card, notice and button on a small phone. No
    existing testID moved, and the whole e2e suite passes.
  - **The e2e uses `cane`, not `gatto`.** E2E specs share one dictionary for the run, and
    `voice.spec.ts` relies on `gatto` appearing in no other spec.
  - **The e2e discard test proves the discard reached the server,** by signing in again and
    reading the empty list.
- **Date:** 2026-10-07
- **Source:** the one-pager `drafts/2026-10-07-photo-word-list-one-pager.md`. `drafts/` is
  gitignored, so everything this spec depends on is restated below.
- **Builds on:**
  - phase 19 (pg-boss, the prepare-session job, its dead-letter queue, the app polling a status;
    ADR 0007);
  - phases 9–13 (the lookup, the shared dictionary, misspelling corrections);
  - phases 10, 20 and 21 (saving per sense, `findSaveable`, `insertEntries`);
  - phase 24 (the `now` collaborator, budgets in `domain/jobs.ts`);
  - the phase 25 design, not yet built: D14, a JSON body with base64 media, and D13, media sent to
    Gemini as `inlineData`.
- **Touches:**
  - the wire gains six routes, all new, so all additive under ADR 0003;
  - a new contract, `VisionClient`, sits beside `LlmClient` under ADR 0001 R11;
  - ADR 0002 R1 gains `expo-image-picker` and `expo-image-manipulator`, and R6's list gains the
    new factories, with `scripts/check-adr-0002-di-with-closures.sh` following R1;
  - two tables, one migration, four queues.

## Goal

A learner in a course gets word lists on a textbook page, a handout or a whiteboard. Sometimes
the Hebrew is printed beside each word and sometimes not. Today each word has to be typed into
the lookup and saved one at a time. This phase reads a photo of the list and turns it into a
review of rows: each row is a word or phrase from the photo, with one sense already chosen. The
learner can untick rows and change senses, then saves the rest in one go.

**Done means:**

1. A photo of a word list, after one review, ends with its words in the saved list. Only words
   the app could not read or look up are typed by hand.
2. Hebrew printed beside a word decides the row's sense. When it names none of the word's
   senses, the row says so (D7).
3. A list without Hebrew starts each row on the word's first sense, the one a typed lookup lists
   first (D7).
4. There is no limit on words per photo.
5. Leaving the screen loses nothing. The import carries on in the background, and home shows it
   until it is saved or discarded (D1, D13).
6. Each outcome above is checked by an automated test. `npm test`, `npm run test:all`,
   `npm run lint:arch`, `npm run e2e` and `npm run eval` pass. The eval has photo cases and
   sense-matching cases, and `TIER2_THRESHOLD` is not lowered.
7. Victor's own use with real class lists decides whether reading is good enough. There is no
   number. The log events in D14 give the measured side: how long a read takes, and how often
   rows were unticked or their sense changed.

## Scope

**In:**
- one photo per import, from the camera or the gallery;
- printed and handwritten lists, with or without Hebrew;
- single words and phrases;
- a review in which every row with a sense starts ticked, and any row can be unticked or switched
  to another of its senses;
- saving the ticked rows in one go;
- every target language;
- several imports open at once, each reviewed and saved on its own;
- eval cases built from real photos, and sense-matching cases.

**Out:**
- pages of real text, with the app picking out the unknown words;
- fixing a misread word in place: untick it and type it in the lookup;
- several photos in one import;
- translations printed in a language other than Hebrew;
- starting a session from the photo's words;
- telling the learner a word is already saved (D7);
- recognising a photo uploaded twice (D12);
- a manual retry for a row whose lookup failed (D10);
- recording on a saved word that it came from a photo;
- keeping the photo once it is read (D3);
- a scheduled cleanup job (D10).

---

## 1. Decisions

**D1. An import runs in the background, and the app polls it.** Victor chose this on 2026-10-07
over two alternatives. In one, the app drives the lookups itself and rows fill in as they
return. In the other, one request does all the work while the app waits.

- *Why.* It is the more stable path, and it leaves room for heavier imports later. Leaving the
  screen, or the phone sleeping, loses nothing.
- *What it costs.* State the app can find again, which means two tables (D4). The photo also has
  to wait somewhere until a worker reads it (D3).
- *Precedent.* Session preparation (phase 19) has the same shape: a record created with its job in
  one transaction, a worker, a dead-letter queue that marks failure, and the app polling.

**D2. Two queues, one job per word.**

- `read-photo` `{ import_id }`: one vision call, then the rows.
- `look-up-import-item` `{ import_id, position }`: one word's lookup and its sense.
- Each has a dead-letter queue, `read-photo-failed` and `look-up-import-item-failed`, whose use
  case marks the import or the row failed. That is phase 19's pattern.
- Retries stay at two with backoff, as for prepare-session.
- Concurrency per process: items run four at a time, like prepare-session. Reads run two at a
  time, because a read is one long call **(low confidence)**.
- *Why one job per word and not one per import.* A slow or failing word holds up nothing else.
  Retries happen one word at a time. A much bigger import later is just more rows.
- A job for an import that is no longer open (it was discarded, or a duplicate delivery arrived)
  returns without calling any model. Discarding an import therefore stops its remaining spend.

**D3. The photo is kept until it is read, then cleared.** Victor approved this on 2026-10-07. The
upload returns at once, and nothing is lost if the phone sleeps during the read. The photo is
cleared in the same transaction that writes the rows. It is also cleared when the read
dead-letters, and when the import is discarded.

- It is stored as base64 `text`, not `bytea`. It arrives as base64 and leaves for Gemini as
  base64, and it lives for seconds, so decoding it to store it would only mean encoding it again.

**D4. Two tables, and "ready to review" is never stored.**

- `photo_imports`:
  - `id` (uuid);
  - `enrollment_id`, which references enrollments as `vocabulary_entries` does;
  - `status`, checked to be `reading`, `read`, `failed`, `saved` or `discarded`;
  - `photo` (nullable);
  - `created_at`;
  - index `(enrollment_id, created_at)`.
- `photo_import_items`, keyed by `(import_id, position)`, cascading from the import:
  - `text` as read;
  - `hebrew` as printed (nullable);
  - `status`, checked to be `pending`, `ready` or `failed`;
  - `corrected_form` (nullable, D8);
  - `options` jsonb: the lookup's saveable senses, each `{ sense_id, variant_id, translation,
    part_of_speech?, example? }`;
  - `chosen_sense_id` (nullable);
  - `ticked`;
  - `hebrew_mismatch`;
  - `reason` (nullable): `sentence`, `no_meaning` or `not_in_language`, for a ready row with no
    options.
- **The status the app sees is derived:**

  | Stored | Derived |
  |---|---|
  | `reading` | `reading` |
  | `read`, some row pending | `looking_up` |
  | `read`, no row pending | `ready` |
  | `failed` | `failed` |

  Two rows finishing at the same moment cannot race over a counter, because there is none.
- `options` is a snapshot. If the dictionary later repairs a sense's wording, the list shows the
  older text until the import is saved. That is harmless, because saving checks every sense id
  as today's save does (D11).

**D5. Reading the photo.**

- **The contract.** `services/llm.ts` gains `VisionClient = (request: LlmJsonRequest & { image: {
  data: string; mimeType: string } }) => Promise<string>`. Its rules are `LlmClient`'s: raw JSON
  text, an empty string when the model returns nothing, and `LlmUnavailable` for every failure.
  `LlmClient` stays text only, as phase 25 D13 argued for audio. Widening it would widen it for
  every caller.
- **The provider.** `providers/gemini.ts` gains `createGeminiVisionClient`, with
  `createGeminiClient`'s dependencies and request. The one difference is that the user turn holds
  an `inlineData` part beside the text. Only `composition.ts` wires it. Phase 25 also sends media
  as `inlineData`, so whichever phase is built first writes that part and the other reuses it.
- **The prompt lives in our code, not in the provider.** `domain/photoReading.ts` builds it and
  parses the answer, as `domain/translation.ts` does for a lookup, so `npm run eval` can score it
  without a database.
- **The answer:** `{ items: [{ text, hebrew }] }`, with `hebrew` empty when none is printed. A flat
  schema, far from the complexity limit the lookup's schema once hit.
- **The instruction** names the enrollment's language and carries a fixed marker, `read the word
  list in this photo`, so MockServer can tell this call from the others. It asks the model to:
  1. return only items in that language, skipping headings, instructions, page and exercise
     numbers, and anything crossed out;
  2. write each item as a learner would type it into a lookup:
     - drop a leading article or "to" (`il gatto` → `gatto`, `to run` → `run`) **(low
       confidence: an article is sometimes part of a phrase)**;
     - drop grammar labels such as `(m.)`, `pl.` and `sb/sth`;
     - drop Russian stress marks;
     - keep a phrase whole (`in bocca al lupo`);
  3. copy the item's Hebrew whole, with all its glosses;
  4. keep page order, top to bottom and column by column;
  5. give its best reading of unclear handwriting rather than leave the item out, because the
     lookup's correction (D8) and the review catch the rest.
- **After the answer.** Items with the same text after `normalizeForm` are merged, and the first
  one's position and Hebrew are kept. Zero items gives a `read` import with no rows, which the app
  explains (D13).
- **Thinking stays at the model's default (low confidence).** Reading handwriting is the case
  where it helps, and the wait is in the background. If reads are slow and good, turn it down.

**D6. Budgets and limits.**

- **The photo.** The app shrinks it to at most 2048 px on its long edge and re-encodes it as JPEG,
  quality 0.8. That is usually 300–700 KB **(low confidence on 2048 for small handwriting)**. The
  wire takes `mime_type: 'image/jpeg'` only, and `image` up to 2 800 000 base64 characters (about
  2 MB).
- **The body.** Hono's `bodyLimit` of 3 MB on the upload route alone answers 413
  `{ error: 'photo too large' }`. It is the first body limit in the app. Every other route keeps
  its current behaviour.
- **The read.** `PHOTO_READ_TIMEOUT_MS` defaults to 120 000, held in `domain/jobs.ts` as phase 24
  D16 does. `read-photo` expires at twice that, phase 19's rule.
- **A word's lookup.** The lookup's 25 s budget applies per call. The longest chain is the main
  call, then reconciliation in parallel, then the match call (D7): 75 s. `look-up-import-item`
  therefore expires at 180 s.
- **No cap on items.** Victor's call. A list of 200 words is 200 jobs at four at a time. The
  `photo_read` event (D14) records the count, so a real heavy import is visible.
- **Spending is bounded** by the photo size and one read per upload. A word already in the
  dictionary makes no lookup call. ADR 0005 stands: there is no authentication, as on every
  route.

**D7. One sense per row: the printed Hebrew's, or the most common.** Victor decided this on
2026-10-07, and asked for every row to offer its other senses as a list.

`look-up-import-item` runs four steps:

1. **The lookup, exactly as if typed:** `translate({ text, from: target, to: 'he',
   enrollment_id })`. It writes to the shared dictionary as a typed lookup does. A correction
   sets `corrected_form` (D8). The senses with a `sense_id` and a `variant_id` become `options`.
   With no options, the row is `ready` and unticked, with a `reason`:
   - `sentence` for kind `sentence`;
   - `not_in_language` for a script-guard refusal;
   - `no_meaning` otherwise.
2. **The sense:**
   - **No Hebrew printed:** the first option, which is the order a typed lookup lists.
   - **Hebrew printed, the free check first.** Split the printed Hebrew into glosses at `,`, `/`
     and `;`. Fold niqqud and punctuation from both sides, with the folding `domain/distractors.ts`
     already has, exported. The first option whose translation equals a gloss wins. Today's
     translations are single words such as `חלון`, so a clean printed list should mostly match
     here **(low confidence: an estimate, which the `matched_by` field measures)**.
   - **No exact match:** one text call through `LlmClient`, with the lookup's budget. It is given
     the word, the printed Hebrew, and the numbered options with their parts of speech, and it
     answers `{ sense: number }`, where 0 means none. `domain/senseMatching.ts` builds and
     parses it.
   - **None:** the first option, with `hebrew_mismatch` set. The row shows "the list says גדה".
3. **The tick:** every row with options starts ticked. **There is no "already saved" check.**
   Victor struck it. Saving a sense the learner already has changes nothing, because the insert
   keeps its `ON CONFLICT DO NOTHING`.
4. **One transaction** writes the row as `ready`, with its options, chosen sense, tick and flags.

The lookup is handed to the import service at the composition root as a collaborator,
`lookup: TranslationService['translate']`. This is the first time a service receives another
service's use case. It does so as a closure, the same way it receives `llm`, and imports only the
type. The lookup's dictionary writes are its own transactions and are independent and
idempotent, which is what ADR 0001 R8 already accepts for them. The row's write is the one write
that depends on this job.

**D8. Misreads are flagged by the lookup's correction, and nothing else.** When the lookup
corrects the text (`gatlo` → `gatto`), the row shows "read as gatlo", and its senses are the
corrected word's. No confidence score is asked of the reader, because a model's opinion of its own
reading is a weak signal and the correction is a strong one. A misread the lookup cannot correct
shows up as "no meaning found" or as a strange sense, and the learner unticks it.

**D9. Routes.** These follow the vocabulary routes in having no user id (ADR 0005).

| Route | Answer |
|---|---|
| `POST /api/enrollments/{id}/photo-imports` `{ mime_type, image }` | 202 with the import's summary; 404 for an unknown enrollment; 413 over the body limit |
| `GET /api/enrollments/{id}/photo-imports` | the open imports' summaries, newest first |
| `GET /api/photo-imports/{id}` | the summary with its rows |
| `PATCH /api/photo-imports/{id}/items/{position}` `{ ticked?, sense_id? }` | the row; 400 for a sense outside its options, or a tick on a row with none; 409 unless the import is open and the row ready |
| `POST /api/photo-imports/{id}/save` | `{ saved_sense_ids }`; the same 200 again for a saved import (D11); 409 for any other import that is not ready |
| `POST /api/photo-imports/{id}/discard` | 204, and 204 again for a discarded import; 409 for a saved one |

- **A summary:** `id`, the derived `status`, `item_count`, `ready_count` and `created_at`.
- **A row:** `position`, `text`, `hebrew`, `status`, `corrected_form`, `options`,
  `chosen_sense_id`, `ticked`, `hebrew_mismatch` and `reason`.

**D10. An import's life.**

- **Open** means not saved or discarded, and less than 14 days old. Only open imports are listed or
  patched. Saving and discarding answer as D9 says, and `GET` returns any import that still
  exists.
- **A failed read** stays listed with "couldn't read this photo" until it is discarded.
- **A failed row** is unticked and shows "couldn't look this up". There is no manual retry: pg-boss
  has already retried it twice, and the lookup screen is still there.
- **Saved and discarded imports stay until the cleanup.** Nothing in the app shows them. A saved
  one is kept so that a repeated save is safe (D11). The saved words do not reference the import,
  so deleting it never touches them.
- **The cleanup has no scheduler (low confidence).** Creating an import deletes the same
  enrollment's imports older than 14 days, in the same transaction. Until then, list queries leave
  them out. pg-boss's cron would also do, but that is a second kind of job for one cleanup, and an
  enrollment nobody uses holds only a few such rows.

**D11. Saving is one transaction.**

- The entries are the ready, ticked rows' chosen options, `{ sense_id, variant_id }`, through
  `firstPerSense`.
- They are checked with `findSaveable` and inserted with `insertEntries`, and the import becomes
  `saved`, all in one transaction. These writes are dependent: a `saved` import with its words
  missing is wrong, and so is the reverse.
- All or nothing, as today's save: a refused sense rolls everything back and answers 400. A
  lookup in the enrollment's own pair always gives saveable senses, so this means a corrupt row,
  not a learner's mistake.
- No 20-entry cap. That limit belongs to the vocabulary request's body, and this save has no list
  in its body.
- **A repeated save** of a `saved` import answers 200 with the same ids and writes nothing. This
  covers a save that committed but whose response was lost.
- Zero ticked rows saves nothing and still marks the import `saved`. The app disables the button
  in that case anyway.

**D12. Imports run side by side, and duplicates are allowed.** Victor decided this on 2026-10-07.

- Two photos make two imports, reviewed and saved separately, and their rows share the queues.
- The same word on two lists gets a row in each. The second lookup is a dictionary hit.
- The same photo uploaded twice makes two imports. The learner discards one.

**D13. The app.**

- **Packages.** `expo-image-picker` and `expo-image-manipulator` are both part of Expo Go, and on
  the web the picker opens a file chooser.
  - `src/photos.ts` declares the narrow engine it needs and `createPhotoPicker({ engine })`, which
    returns `take()` and `choose()`. Each gives `{ base64, mimeType: 'image/jpeg' }` or `null`
    when cancelled, after shrinking the photo (D6). A denied permission also gives `null` and
    sets `denied`, which the screen explains.
  - Only `_layout.tsx` imports the two packages (ADR 0002 R1).
  - The manipulator returns base64 itself, so phase 25's Android problem reading a file URI does
    not arise.
  - `app.json` gains the picker's plugin with its camera and photo-library texts.
- **Home:**
  - a third button, "words from a photo", under translate and saved words;
  - while any import is open, a card above the buttons: "reading your photo…" or "photo list:
    32 words to review". It opens the import, or the list when there are several.
  - The card refreshes on focus. While an import is reading or looking up, it also refreshes
    every 3 s, as the session card does while a session is preparing.
- **`app/photo-imports/index.tsx`:** "take a photo" and "choose from gallery", with the open
  imports below. Picking a photo uploads it and replaces this screen with its review. A failed
  upload shows the error and keeps the photo, so the learner can retry.
- **`app/photo-imports/[id].tsx`, the review:**
  - **The status line:** "reading the photo…", "looking up 12 of 32", "ready", or "couldn't read
    this photo".
  - **Rows in page order.** Each has its tick, the word, the chosen sense's Hebrew and part of
    speech, and any note ("read as gatlo", "the list says גדה").
    - A pending row shows a placeholder.
    - A row without options, or a failed one, shows why, and its tick is disabled.
  - **The options list.** Tapping the meaning opens the row's options, each with its Hebrew, part
    of speech and example. Picking one closes the list.
  - **Changes are sent as they happen.** Each tick or sense change is sent at once, shown before
    the server answers, and reverted if it is refused, as the save toggles do today.
  - **The footer:**
    - "save 28 words": the ticked count, enabled once the import is ready and something is
      ticked. Afterwards the app goes home with "28 words saved".
    - "discard": confirmed through `src/confirm.ts`, which works on the web too.
    - An import with no rows says "no Italian words found on this photo" and offers only
      "discard".
  - **Polling** every 2 s while reading or looking up. It stops at ready or failed, or when the
    screen loses focus.
- **Strings.** Every label is in Hebrew in the strings module, right to left like the rest of the
  app.

**D14. Measured.**

- **`photo_import_created`:** `import_id`, `bytes`.
- **`photo_read`:** `import_id`, `item_count`, `hebrew_count`, `merged_count`, `read_ms`. The
  duration comes from the `now` collaborator.
- **`import_item_looked_up`:** `import_id`, `position`, `matched_by` (`exact`, `model`, `none` or
  `no_hebrew`), `corrected`, `option_count`, `reason`.
- **`photo_import_saved`:** `import_id`, `saved_count`, `unticked_count`, `changed_sense_count`,
  where a changed sense is one that differs from the sense first chosen. That is how often the
  default was wrong, the measured side of Victor's judgement.
- **The failure paths log** `photo_read_failed` and `import_item_failed`.
- The photo and the Hebrew are never logged.

**D15. One spec, two PRs, server first.**

- **PR A:** the server and the eval. The routes are exercised by integration tests.
- **PR B:** the app and e2e.
- *Why.* The reason is risk, not size. PR A's eval shows whether reading real photos, handwriting
  especially, is good enough before any screen is built. If it is not, the course changes while
  that is cheap.

---

## 2. Changes

### `packages/core`

`api/schemas.ts`:
- `PhotoImportCreateRequestSchema`: `mime_type: z.literal('image/jpeg')`, `image` (1 to 2 800 000
  characters).
- `PhotoImportStatusSchema`: `reading`, `looking_up`, `ready`, `failed`.
- `PhotoImportSummarySchema`, `PhotoImportOptionSchema`, `PhotoImportItemSchema` and
  `PhotoImportSchema` (the summary with `items`), as D9.
- `PhotoImportListSchema`, `PhotoImportItemUpdateSchema` (`ticked?`, `sense_id?`, at least one
  of them) and `PhotoImportSaveResponseSchema`.

`api/types.ts` and `api/index.ts` gain their inferred types (ADR 0003 R3, R4).

### Server

- **`db/schema.ts` and migration `0018_photo_imports.sql`:** the two tables of D4.
- **`domain/jobs.ts`:**
  - the four queue names and two payload schemas;
  - `PHOTO_READ_BUDGET_MS` and the two expiries;
  - a unit test asserting the twice-the-budget rule.
- **`db/jobs.ts`:** the four queues in `JOB_QUEUES`, each dead-letter queue first.
- **`domain/photoReading.ts`:** the reader's prompt and its parse, and merging duplicates.
- **`domain/senseMatching.ts`:**
  - `glossesOf(hebrew)`;
  - `matchExact(glosses, options)`;
  - the match call's prompt and parse;
  - `chooseSense(...)`, which returns the chosen option, the mismatch flag and `matched_by`.
- **`domain/photoImports.ts`:** `deriveStatus`, `isOpen`, and the checks for a PATCH and a save.
- **`domain/distractors.ts`:** exports its Hebrew folding.
- **`services/llm.ts`:** `VisionClient`.
- **`services/photoImports.ts`:** `createPhotoImportService({ transaction, vision, llm, lookup,
  now, logger })`, with these use cases:
  - `create`, `list`, `get`, `updateItem`, `save` and `discard`;
  - `readPhoto` and `failRead`, which the queues call;
  - `lookUpItem` and `failItem`, which the queues call.
- **`repo/photoImports.ts`:** `createPhotoImportRepo(tx)`, with these primitives:
  - `insertImport`, `deleteExpired`, `findImport`, `listOpen`, `transition`, `clearPhoto`;
  - `insertItems`, `findItem`, `writeItem`, `markItemFailed`, `updateItem`, `listItems`.
- **`repo/jobs.ts`:** unchanged; `enqueue` already takes any queue in `JobPayloads`.
- **`providers/gemini.ts`:** `createGeminiVisionClient`, sharing the request and error mapping
  with `createGeminiClient`.
- **`config.ts`:** `PHOTO_READ_TIMEOUT_MS`.
- **`composition.ts`:**
  - the vision client;
  - the service, handed `translations.translate` as `lookup`;
  - `photoImports` in `AppDeps`.
- **`worker.ts`:** four `boss.work` registrations, each calling one use case (ADR 0007 R4).
- **`routes/photoImports.ts`:** the six routes of D9, with `bodyLimit` on the upload. **`app.ts`**
  mounts it. **`errors.ts`** gains `PhotoImportNotFound`, `PhotoImportNotOpen` and
  `InvalidPhotoImportItem`.
- **ADR 0002:** R6's factory list gains `createPhotoImportRepo`, `createPhotoImportService`,
  `createGeminiVisionClient` and `createPhotoPicker`.

### Mobile

- **`package.json`:** `expo-image-picker` and `expo-image-manipulator`, at the ranges Expo SDK 57's
  `bundledNativeModules.json` names.
- **`app.json`:** the picker's plugin.
- **`src/photos.ts`:** `createPhotoPicker`.
- **`src/app/_layout.tsx`:** builds the picker's engine and provides the picker.
- **`src/api/client.ts`:** `createPhotoImport`, `listPhotoImports`, `getPhotoImport`,
  `updatePhotoImportItem`, `savePhotoImport` and `discardPhotoImport`.
- **`src/hooks/usePhotoImports.tsx`:** the open list, for home and the list screen.
  **`src/hooks/usePhotoImport.tsx`:** one import, its polling, and optimistic changes.
- **Screens:** `src/app/photo-imports/index.tsx` and `src/app/photo-imports/[id].tsx`. The home
  screen, `src/app/index.tsx`, gains the button and the card.
- **Strings:** the strings module.
- **ADR 0002:** R1 and its check script name the two packages.

### Eval

- `tests/eval/fixtures/photos/*.jpg`, about eight of Victor's photos, shrunk as the app shrinks
  them:
  - printed lists, with Hebrew and without it, across English, Russian and Italian;
  - a page with headings and exercise text around the list;
  - a whiteboard;
  - handwritten notes.
- **`PhotoCase`:** `{ file, language, tier, expect: [{ text, hebrew? }] }`.
  - An item counts as found when its text matches after `normalizeForm` and lower case, and its
    Hebrew, if expected, matches after folding.
  - Tier 1 covers clean printed lists: every item found and nothing extra.
  - Tier 2 covers handwriting and messy pages, scored as found ÷ (expected + extra) towards
    `TIER2_THRESHOLD`.
- **`MatchCase`:** `{ word, language, hebrew, options, expect: number | 'none' }`. Clear cases are
  tier 1. Near-synonyms and a different part of speech are tier 2.
- `askPhoto.ts` beside `askModel.ts`. It calls the domain's prompt and parse directly, with no
  database.

---

## 3. Testing

### Unit

- **core:** the schemas accept and refuse the shapes in D9, and `image` refuses more than
  2 800 000 characters.
- **server domain:**
  - the reader's prompt holds the marker and the language name;
  - the parse refuses a malformed answer and merges duplicate texts, keeping the first;
  - `glossesOf` splits at `,`, `/` and `;`;
  - `matchExact` folds niqqud on both sides and prefers the first option;
  - the match call's parse treats 0 and an out-of-range number as none;
  - `chooseSense` covers no Hebrew, an exact match, a model match and none;
  - `deriveStatus` covers all four statuses;
  - the PATCH and save checks;
  - the budget and expiry rule.
- **server services (fakes):**
  - `readPhoto` writes the rows, clears the photo, enqueues one job per row, and skips a closed
    import without calling the reader;
  - `lookUpItem` covers no Hebrew, an exact match without a model call, a model match, a
    mismatch, a correction, each `reason`, and a closed import without a lookup;
  - `save` and a repeated save;
  - the log events, with the fake clock's duration.
- **provider (fake fetch):** the request holds the image as `inlineData` and the marker, an empty
  candidate gives an empty string, and the timeout gives `LlmUnavailable`.
- **mobile:**
  - `createPhotoPicker` with a fake engine: the resize settings, cancel and denial;
  - `usePhotoImport`: a change shown at once and reverted on refusal, and polling that stops at
    ready and on blur;
  - the home card's states.

### Integration (real Postgres)

- the migration, and the tables' checks refusing an unknown status;
- the repositories, including `deleteExpired` and `listOpen` leaving out old, saved and discarded
  imports;
- **an import end to end through the real queue,** with the vision call and the lookup's model
  stubbed by MockServer: upload, read, rows, ready, a sense changed, a row unticked, save, and the
  saved list holding exactly the ticked rows' chosen senses;
- **both dead-letter paths:** a read that always fails ends `failed` with the photo cleared, and
  a row that always fails ends `failed` while its siblings are ready;
- **routes:**
  - the upload answers 202, and 404 for an unknown enrollment;
  - 413 over 3 MB;
  - 400 for a sense outside the options, or a tick on a row without options;
  - 409 for saving before ready, and for patching a discarded import;
  - a repeated save answers 200;
  - discard is idempotent.

### E2E

`photo-import.spec.ts`, in Chromium. The photo is picked through the file chooser
(`page.waitForEvent('filechooser')`) from a fixture JPEG. MockServer answers the read by its
marker with three items: one whose Hebrew matches exactly, one whose Hebrew matches no sense, and
one with no Hebrew. It also answers their lookups. The spec:

- sees the rows fill in;
- checks the mismatch note;
- changes the third row's sense and unticks the second;
- saves, and finds exactly the right senses in the saved list.

A second test leaves the review before it is ready, sees the home card, and reopens the import
from it.

### Eval

The photo and matching cases (§2), run against the real model until they pass reliably. A failing
case changes the instruction, never the threshold.

---

## POC findings

Run on 2026-10-07, before the plan, to test D5's and D6's assumptions. Seven synthetic
photos (the eval fixtures) were each sent to `gemini-2.5-flash` with D5's instruction from
a scratch script: once with thinking at the model's default, once with `thinkingBudget: 0`.

| Question | Answer |
|---|---|
| Does the reader find every item, in order, and skip the rest? | With default thinking, yes, on all seven. It skipped headings, the exercise line, page numbers, the whiteboard's date and a crossed-out word, and dropped articles and stress marks. |
| Does it copy the printed Hebrew? | Yes, whole, including two-word glosses (`חדר שינה`, `מזג אוויר`). |
| Thinking off? | Faster, 1.6–1.8 s against 3–6 s, but it dropped every Hebrew gloss on the printed Italian page, kept the crossed-out word and kept `sb`/`sth`. D5's default thinking stands. |
| Is "to" or "the" before a phrase dropped consistently? | No: `to look after` and `the weather` were sometimes kept. The eval accepts both spellings, and a lookup handles both. |
| How long is a read? | 3–6 s for 5–11 items at 1500 × 2000, well inside D6's 120 s. |

## Build order

**PR A, the server and the eval:**

0. **Feasibility, before any plan task depends on it.** Send three of Victor's photos (printed with
   Hebrew, a whiteboard, handwritten notes) to `GEMINI_MODEL` with D5's instruction, from a scratch
   script. Record what was read, how long it took, and whether a lower thinking setting changes
   either. The results go into this spec as POC findings, as phase 25's did.
1. Core schemas and types.
2. Domain: `photoReading`, `senseMatching`, `photoImports`, the folding export, and the job names
   and budgets.
3. The vision client: contract, provider, config, composition.
4. Migration 0018, the repository, the service, the queues and the worker, the routes.
5. Eval fixtures and cases, run against the real model.
6. Integration tests.

**PR B, the app and e2e:**

1. The packages, `app.json`, `createPhotoPicker`, and ADR 0002 R1 with its check, planting a
   violation first.
2. The API client and the hooks.
3. The two screens and home.
4. E2E.

## Risks

- **Handwriting.** The whole phase rests on the reader. Step 0 and the eval measure it on Victor's
  own photos before any screen exists (D15). Victor's use after merge is the real test.
- **An article dropped from a phrase.** D5's rule 2 could turn `la dolce vita` into `dolce vita`.
  The eval has a case for it; if it fails, the rule narrows to single words.
- **A wrong default sense goes unnoticed.** On a list without Hebrew, the first sense is a guess.
  The review exists for this, but only if the learner reads it. `changed_sense_count` shows how
  often the default was changed. It cannot show a wrong default that nobody changed.
- **Quota.** A 60-word list of new words is up to about 420 model calls in the worst case (one main
  call and five reconciliations each, plus a match). Four item jobs at a time keep the rate where
  prepare-session already runs, but a long list takes minutes. That is acceptable in the
  background, and `photo_read`'s `item_count` with the per-row events shows it.
- **Migration number.** Phase 25 also planned migration 0017 and merged first, so ours became 0018.
- **Eval photos in the repository.** Fixtures are about 500 KB each, and they must show no one's
  name or face. Victor chooses them.
