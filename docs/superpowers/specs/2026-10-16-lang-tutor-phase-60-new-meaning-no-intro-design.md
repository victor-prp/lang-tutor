# Phase 60 — a new meaning gets no intro stage

- **Date:** 2026-10-16
- **Source:** `drafts/2026-10-16-new-meaning-no-intro-one-pager.md` (main checkout)
- **Builds on:** phase 39 (gloss families, the `new_meaning` card), phases 54–55 (the ladder and
  its intro stage)

## Goal

When a known word starts a new meaning, Victor gets the "פירוש חדש למילה שאתם מכירים" card
*and then* the new-word intro stage (meet card, say it, write it, three practice cards) for the
same meaning. The meaning is introduced twice, and a word he can already say and spell gets the
full new-word treatment.

**Done means** (Victor):

1. On Victor's phone: a new meaning of a known word shows the new-meaning card once, with no
   meet, say or write cards after it, and later sessions practise it as usual. (Left for Victor:
   it needs the release.)
2. Unit tests pin the rule.

`npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Cause

Phase 54 (D2) already meant a family's introduction to have no ladder: `chooseWords` sets
`ladder` only for a NEW pick that `glossFamilies` does not list in `introductions`. But
`introductions` lists the family's current meaning only while it is **unpractised** (no memory
row). The new-meaning card is a four-option choice on a meaning never shown, so it is often
missed. A miss writes an Again row: the gloss is now practised, so it leaves `introductions`,
and it is unlearned (only Agains), so phase 54 classes it NEW — and a NEW pick outside
`introductions` is a ladder. The next session asks it as meet, intro stage and three practice
cards.

## Design

- **D1. No ladder for a new meaning.** `glossFamilies` returns a new set, `newMeanings`: the
  current gloss of every family with at least one known member, practised or not. It contains
  `introductions`' glosses and also a current meaning that was already asked. `chooseWords`
  reads `newMeanings` in place of `introductions` for the ladder rule: a NEW gloss in
  `newMeanings` is one slot and asked by its rung, never a ladder. (`ChoiceInput.families.
  introductions` is renamed `newMeanings`.)
- **D2. The card is unchanged.** `introductions` (the map of known meanings) still decides which
  pick is a `new_meaning` card, exactly as today: only the unpractised current meaning. A missed
  new meaning comes back as an ordinary card — a multiple choice at rung 1 — then normal spaced
  practice, which is the one-pager's "then normal spaced practice".
- **D3. Waiting meanings keep their ladder.** A target-listed meaning that waits behind its
  family's current one (phase 53 I1) is not current, so it is not in `newMeanings` and keeps its
  ladder, since nothing else would show it before it is asked.

### Calls made (builder check)

- **A pure function of today's rows.** `newMeanings` reads the families as they are now, with no
  record of the card being shown. A gloss that was laddered as a new word, missed, and whose
  sibling became known since loses its ladder from the next session: it is now a new meaning of a
  known word, which is what this phase treats without one. A session's cards are prepared
  together, so nothing changes inside a session. My call.
- **Its rung is `rungFor(r)`, not forced.** A miss's Again row leaves R below `RUNG_R`, so it is
  rung 1 in practice; the tests assert "not a ladder, one slot", not a card type. My call.
- **Targets too.** A target-listed meaning that is its family's current one is in `newMeanings`
  and gets no ladder, as on the main path. My call.
- **`introductions` stays** on `Families` beside `newMeanings`; only `ChoiceInput.families`
  swaps its set. My call.
- **The day simulation** is compared with master's marks; no mark is lowered.

## Out

- The new-meaning card's look and copy.
- New words (no known family member): phase 55's intro stage unchanged.
- How `glossFamilies` picks a family's current meaning and its known ones.
- How many new meanings a session holds, or the daily cap.

(The one-pager's "a family's new meaning — unchanged" is read as the last-but-one line: the fix
itself is in the family path, since that is the only path with a new-meaning card. My call.)

## Tests

- `glossFamilies.test.ts`: `newMeanings` holds an unpractised current meaning (as
  `introductions` does) and a practised one with only Agains; not a family with no known member,
  not a waiting member.
- `choose.test.ts`: a NEW gloss in `newMeanings` with an Again row is not a ladder and costs one
  slot; the same gloss outside `newMeanings` is a ladder (phase 54's rule for new words, kept).
- The day simulation reads `newMeanings` where it read `introductions` for the ladder.
