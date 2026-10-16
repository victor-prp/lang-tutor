# Phase 58 — Remove every new word at once

- **Status:** Victor approved D1–D3 one by one in chat on 2026-10-16, then said "continue till PR":
  D4–D6 are self-approved (CLAUDE.md, *Continue till PR*). Implemented inline on branch
  `phase-58-remove-new-words`.
- **Date:** 2026-10-16
- **Source:** `drafts/2026-10-16-remove-new-words-one-pager.md` (main checkout).
- **Builds on:** phase 20 (levels, the list's level filter), phase 21 (the list by lemma, the
  per-sense unsave), phase 28 (`vocabulary.remove`, owner only), phase 53 (targets lose an unsaved
  word, with a `words_removed` event, and restock).
- **Touches:** core's wire schemas, the vocabulary route, service and repository, the targets
  repository, the app's client, vocabulary hook and list screen, the auth matrix and e2e.

---

## Goal

Victor tests with homework lists and ends up with many "new" (level 1) Italian words he never meant
to keep. The app removes one sense at a time from a word's page, so his only reset is a script
against the REST API: 112 DELETE calls on 2026-10-15, 11 more on 2026-10-16, each after an emailed
sign-in code. This phase lets him filter the word list to new and remove every word shown in one
action.

**Done means** (Victor): tests prove it. On his phone, after the action, the new filter shows no
words and the unfiltered list no longer has them (assumed).

## Scope

**In:** one endpoint that removes every word at a level (D2), in one transaction with the target
bookkeeping a single unsave does (D3); a button on the list with the new filter on, behind a
confirmation (D4).

**Out** (the one-pager): ticking individual words; undo or restore; the action on any filter but
new; removing from a shared list (a tutor holds no `vocabulary.remove`, so the endpoint is the
owner's alone already).

## Decisions

**D1 — The word is the unit** (Victor, approved). The list shows words, one badge each, and the
filter is on the badge. The action removes every saved sense of every word whose badge is the
level, including a sense of that word at another level. A word shown as new can therefore lose a
level 2 sense; under the stricter "level 1 senses only" reading it would survive with a jump to a
level 2 badge, which reads as a bug. A sense a tutor added goes with the rest, as a single unsave
by the owner already allows.

**D2 — One endpoint, selected by level** (Victor, approved).

```
DELETE /api/enrollments/{id}/vocabulary?level=<1–5>
  200 { removed_words: int, removed_glosses: int }
  400 level missing or not 1–5        403 not the list's owner        404 no such enrollment
```

`level` is required and is the same parameter and range the list's GET takes, so the endpoint is
not named after one filter; the app only sends 1. The words are those whose badge is the level
when the server runs the call, by the list's own level expression (`wordsPage`'s LATERAL over the
live dimensions), not a stale screen. A second call finds nothing and answers 200 with zeros, so a
retry is safe. The endpoint is added and nothing is renamed or removed, so `API_LEVEL` stays
(ADR 0012).

**D3 — One transaction, one restock, recorded where unsaves already are** (Victor, approved).
The service's `removeLevel` does what `unsave` does, once for the batch: authorize
`vocabulary.remove`; take the next-session lock; read the saved gloss ids of every word at the
level; share-lock and resolve them through merges (phase 31), deleting the survivors' entries (their
`gloss_progress` rows cascade, phase 20); remove them from every target and write one
`words_removed` event per target changed, `before.gloss_ids` listing every gloss that left it
(sorted) and `after.reason` `'unsaved'`; then restock once, whenever anything was removed (R1). It logs one
`vocabulary_level_removed` line with the enrollment, the level and both counts, after the
transaction, and `logTargetRetired` as unsave does. No new table: undo is out, and the request log
already keeps the call and its answer.

**D4 — The button** (self-approved). With the new chip selected and at least one word loaded, a
text button under the chips reads `הסרת כל המילים החדשות`. It asks first through `confirm.ts`:
title `להסיר את כל המילים החדשות?`, message `כל המילים ברמה "חדשה" יוסרו מהרשימה ומהיעדים. אי אפשר
לבטל.`, confirm `הסרה`, cancel `ביטול` (the existing `strings.cancel`). On yes the hook calls the
endpoint with level 1 and reloads the list, which then shows the empty-level notice. While the call
runs the button is disabled; a failure shows `ההסרה נכשלה. נסו שוב.` under the chips and keeps the
list. No other chip shows the button.

**D5 — Layers** (self-approved). Core: `RemoveVocabularyLevelQuerySchema` (`level` required, the
GET's coercion and range) and `RemoveVocabularyLevelResponseSchema`. Repository primitives:
`vocabulary.findGlossIdsAtLevel({ enrollmentId, level, live })`,
`vocabulary.deleteEntries({ enrollmentId, glossIds })`, and
`target.removeGlossesFromTargets(enrollmentId, glossIds)` answering each changed target with the
gloss ids it lost. The route is transport only; the client gains `removeVocabularyLevel`.

**D6 — Tests** (self-approved).
- Route integration: removes every saved sense of the level's words, including a level 2 sense of
  a word whose badge is 1; leaves a level 2 word and another enrollment's list; a repeat answers
  zeros; 400 for a missing, `0`, `6` or non-numeric level; 404 for an unknown enrollment; 403 for a
  stranger and for an accepted tutor.
- Service integration over targets: one `words_removed` event per target with every gloss that
  left it, and the other words kept.
- The auth matrix's operation list gains the new operation.
- App unit: the client sends `DELETE …/vocabulary?level=1`.
- e2e: a learner with two new words and one at level 2 selects new, removes all, accepts the
  dialog, and sees the empty-level notice; the unfiltered list keeps only the level 2 word.
- `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Rulings

- **R1 (final review I1) — D3 amended: the removal restocks even when no target held its
  words.** A single unsave restocks only for a target (phase 53 D12), and a stray card is
  accepted there. For the reset this phase exists for, an unstarted list stock chosen from the
  removed words would serve them as the next session, so the stock goes and a new one is asked
  for, with the stock reason and the `session_retired` reason `words_removed`. Nothing at the
  level leaves the stock alone. Cost if wrong: one extra stock build per removal.
