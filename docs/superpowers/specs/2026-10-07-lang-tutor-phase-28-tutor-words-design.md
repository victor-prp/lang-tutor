# Phase 28 — A tutor adds words to a student's list

- **Status:** Designed on 2026-10-07. Victor scoped the phase in the one-pager, then approved, in
  conversation, linking a tutor to one of the student's languages (D2), a tutor who learns nothing
  (D13), access grants with one check as the first step towards general access control (D1, D6,
  D7), and the data shape (§2). He then handed the remaining decisions over ("Continue with the
  design by yourself … I trust your decisions"). Every decision is in §1 with its reason, so each
  one can be overturned in review. Those marked **(low confidence)** are the ones to read first.
- **Date:** 2026-10-07
- **Source:** the one-pager `drafts/2026-10-07-tutor-adds-words-one-pager.md`. `drafts/` is
  gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 8 ("Why `users` has no role column", and ADR 0005); phase 16 (enrollments,
  the composite `(user_id, id)` key); phases 18, 20 and 21 (the saved list, progress per sense, the
  list by lemma). Phases 26 and 27 are in flight on their own branches; see Risks.
- **Touches:** one new table and one new column. Four new endpoints, and a required header on the
  two vocabulary writes, under ADR 0003. A new ADR 0008 with its check script, which amends ADR
  0005. One new repository, one new service, one new domain module. Mobile gets three new screens'
  worth of UI, and home stops assuming a language.

## Goal

A private tutor teaches one student at a time. After a lesson they have no way to put its words
into that student's list, so the student types them in again. This phase lets the tutor invite a
student, and once the student accepts, add words to that student's list in the language they
teach. The student sees which words came from the tutor, and either of them can end the link.

It is also the first step towards general access control. Victor's direction: tutors will later
read the student's list, progress and analytics. So the link is built as an **access grant** with
a **role** that maps to **permissions** and one **check**, not as a tutor feature with its own
endpoints. Each later permission is one line in a map and the screen that uses it.

**Done means:**

1. A tutor adds a word for a student, and it shows up in the student's saved list, marked as
   coming from that tutor (D11).
2. That word comes up in the student's sessions like any other saved word, and practising it moves
   its progress (D5).
3. A tutor can add words only for their own students. The server refuses a word from anyone who is
   not the list's owner and holds no accepted grant that allows it, and the app shows a tutor only
   their own students (D6, D7, D14).
4. Each outcome above is checked by an automated test. `npm test`, `npm run test:all`,
   `npm run lint:arch` and `npm run e2e` pass. ADR 0008's check script reports a planted violation
   of each of its rules.

## Scope

**In:**
- a tutor invites a student by username, for one language the student is learning;
- the student accepts or declines; either side can end the link, and a tutor can cancel an invite;
- a tutor looks up words in the student's language pair and adds them to the student's list;
- the student sees "added by" on those words, in the list and on the word's page;
- an account that learns nothing can use the app as a tutor;
- `enrollment_grants`, the `tutor` role, the permission map, the check, the actor header, ADR 0008.

**Out** (from the one-pager):
- groups: one set of words sent to a whole class;
- the tutor seeing the student's list or progress. Reads stay as they are;
- parents adding words for their kids;
- the tutor changing or removing a word once added. The student's delete is the only undo;
- the student declining a single tutor's word, beyond that delete;
- photo import on the tutor's side;
- real authentication. Victor: "login will be implemented later".

**Also out**, decided here:
- notifications. The student sees an invite the next time home loads (D12);
- per-grant custom permissions. A grant carries a role, never a list of permissions (D6);
- checks on reads. No non-owner reads anything yet (D7).

---

## 1. Decisions

**D1. A grant names its target; nothing is stored on the user.** Phase 8 argued that a `role`
column on `users` is either wrong or redundant, because `role = 'tutor'` cannot say *whose* tutor.
A role on a **grant** can: "Rina is tutor **of Victor's Italian list**". "Is a tutor" is a query
(does this account hold grants?), never a column. This is the `(guardian, learner, relation)`
shape phase 8 predicted, with the list as the target rather than the person (D2).

**D2. A grant is on one enrollment, not on the person.** Victor approved this. A tutor teaches a
language, and each enrollment is one language's list, so the grant also settles which list a word
goes into. The server already refuses a sense that is not in the enrollment's target language.

**D3. An invite needs the student to be learning that language already.** A grant points at an
existing enrollment. An invite to a list that does not exist yet would need a second kind of
pending row, keyed by `(user, language)`, that turns into a grant later. The tutor gets "Victor
isn't learning Italian here yet", and they sort it out at the next lesson. This walks back a line
in the conversation that said the invite could wait for the student to enroll.

**D4. Declining, cancelling and ending all delete the grant.** There is no history table and no
`ended_at`: nothing reads an ended grant. Words a tutor added stay in the list with their label,
because the label points at the tutor's account (D5), not at the grant. Either side may end an
accepted grant. The student ends it from their profile, and the tutor from the student's screen.
The tutor ending it is an addition to the one-pager **(low confidence)**: it costs nothing, since
the delete already has to accept the grantee for cancelling an invite.

**D5. `vocabulary_entries.added_by_user_id`, NOT NULL, backfilled to the list's owner.** Every row
says who put the sense in the list. Null meaning "the owner" was rejected: it is a convention every
reader has to know, and a later actor kind would need a third meaning. The label shows when the
adder is not the list's owner. A tutor's save goes through the one existing writer,
`insertEntries`, so its progress rows are created in the same statement and the sense enters
sessions like any other (done-means 2). **First adder wins**: the insert's `ON CONFLICT DO
NOTHING` already keeps the first form, and now it keeps the first adder too. If a student removes
a tutor's word and the tutor adds it again, it comes back with the label again. That is accepted.

**D6. Roles map to permissions in one pure module.**

```ts
// apps/server/src/domain/access.ts
export const PERMISSIONS = ['vocabulary.add', 'vocabulary.remove'] as const;
export const ROLES = ['tutor'] as const;
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = { tutor: ['vocabulary.add'] };

may(actorUserId, ownerUserId, grant: { role; accepted } | null, permission): boolean
  // the owner may do anything with their own list;
  // anyone else needs an ACCEPTED grant whose role includes the permission;
  // a pending grant allows nothing.
mayAnswerInvite(actorUserId, grant): boolean   // the owner only
mayEndGrant(actorUserId, grant): boolean       // the owner or the grantee
```

A permission is a dotted `resource.verb` string. Adding "tutors read progress" later is
`'progress.read'` in `PERMISSIONS`, in the tutor's list, and a call to the check in the read's use
case. It needs no migration, and no grant changes.

**D7. The actor is a request header, asserted, read in one place.**

- `X-Acting-User-Id: <user id>` names who is acting. Today it is asserted, as every identity here
  is (ADR 0005). Login will replace it with the authenticated identity, and nothing behind the
  header changes. **The header is the slot login will fill.**
- On the server it is read only in `routes/actor.ts`, which exports the zod header schema and its
  OpenAPI description. A route declares it under `request.headers`. A missing or empty header is
  the usual 400 `invalid request`. Services receive `actorUserId` as a plain argument.
- **Which endpoints require it, this phase:** the two vocabulary writes (save needs
  `vocabulary.add`, unsave needs `vocabulary.remove`) and the four grant endpoints (D9). Reads are
  unchanged and take no header: no non-owner reads anything yet, and checking the owner's own reads
  is login's job.
- This makes "a tutor can't remove a word" a rule the server enforces. A tutor holds
  `vocabulary.add` only.
- In the app the header is built in one place in `api/client.ts`, and the calls that need it take
  `actorUserId` as their first argument. The client stays a factory with no module state (ADR
  0002): it is created before anyone logs in, so it cannot hold the user.
- **It is a correctness boundary, not a security one.** An honest app cannot write to a stranger's
  list. Anyone can still claim any user id, exactly as anyone can type any username today. ADR 0008
  says this in so many words, and the header's published description says it authenticates
  nothing, which `openapi.test.ts` asserts, as it already does for login.

**D8. One check, inside the use case's transaction, before anything is written.**

```
services/access.ts   authorize(repos, actorUserId, enrollment, permission): Promise<void>
                     loads the actor's grant on that enrollment (repos.grant), calls may(),
                     logs access_denied and throws AccessDenied when it says no.
```

The order of refusals on a vocabulary write: 400 for a bad body or header, then 404 if the
enrollment does not exist, then **403 `forbidden`**, then 400 for an entry that cannot be saved
there. The 404 comes first because the check needs the enrollment's owner. A 403 body is
`{ error: 'forbidden' }`, and the log line carries the detail.

**D9. The grant API.** All four take the actor header.

| Endpoint | Actor | Answers |
|---|---|---|
| `POST /api/grants` `{ username, target_language }` | the tutor | 201 `Grant` (pending); 404 `user not found`; 409 `not_learning` (D3); 409 `own_list` (yourself); 409 `grant_exists` |
| `GET /api/grants` | anyone | 200 `{ tutors: Grant[], students: Grant[] }`: grants **on** the actor's lists, and grants the actor **holds**. Both pending and accepted, newest first |
| `POST /api/grants/{id}/accept` | the list's owner | 200 `Grant` (accepted; idempotent); 404 `grant not found`; 403 for anyone else |
| `DELETE /api/grants/{id}` | the owner or the grantee | 204, also when there is no such grant (idempotent, like unsave); 403 for anyone else |

```ts
Grant = {
  id; role: string; status: 'pending' | 'accepted';
  enrollment: { id; source_language; target_language };
  owner:   { id; username; display_name };   // the student
  grantee: { id; username; display_name };   // the tutor
  created_at; accepted_at: string | null;
}
```

`role` is a plain string on the wire, for the reason `UserSchema`'s language fields are: a later
role must not fail validation in a client that shipped before it. `GET /api/grants` is scoped to
the actor and needs no permission: it lists only grants the actor is a party to. The grantee needs
`enrollment.id` (to save) and the language pair (to look up). Seeing them on a pending grant is
harmless, because every write is checked.

**D10. The tutor's lookup marks nothing, and only adds.** The tutor looks up words in the student's
pair, explained in the student's source language, which is Hebrew for every enrollment made since
phase 16. The lookup sends **no** `enrollment_id`. With one, the server would mark which senses the
student has saved, and that is reading the student's list, which is Out. Without one, the server
marks nothing. So in tutor mode the app offers "add" on every sense of a target-language answer
that has ids, and keeps "added" locally. Tapping an added card does nothing: there is no remove. A
sense the student already had is a no-op on the server (D5) and still reads "added". That is the
truth from the tutor's side.

**D11. The label, on the wire and on screen.**

- `VocabularyWordSchema` gains `added_by: string[]`: the display names of the people **other than
  the list's owner** who added any of the word's saved senses. Distinct and sorted, and `[]` when
  the student added everything themselves.
- `VocabularySenseSchema` gains `added_by?: string`: present on a saved sense that someone else
  added, holding their display name.
- On screen there is a muted line under the word's headline in the list, and under the sense's
  translation on the word's page: "נוסף ע״י רינה" ("added by Rina"). Two or more names join with
  a comma.
- A display name, not a username. It is what the student knows the tutor by, and it is what the
  app already shows a person as.

**D12. The student's side: invites on home, tutors on profile.**

- Home shows a card for each pending invite, above everything else: "רינה רוצה להוסיף מילים לרשימת
  האיטלקית שלך" ("Rina wants to add words to your Italian list"), with **Accept** and **Decline**.
  There are no notifications, so this card is how the student finds out. It shows whichever
  language is active, because an invite is the student's to answer either way.
- Profile lists accepted tutors, one row each ("רינה · איטלקית"), with **End**, after a
  confirmation (`confirm.ts`).

**D13. A tutor who learns nothing. (low confidence on the sign-up path)** Victor approved this.

- Home redirects to `/enroll` only for an account with **no enrollments and no grants either way**:
  a brand-new account, which is the same as today for a learner.
- `/enroll`, reached that way, gains a secondary button, **"I'm here to teach"** ("אני כאן כדי
  ללמד"), which opens the invite screen. Once an invite exists, the account holds a grant, and home
  stops redirecting.
- Home with no active enrollment shows no learning block. It shows a "Start learning a language"
  button that opens `/enroll` (the switcher's existing add path). A learner who teaches sees both
  blocks.
- Every learning screen (`session`, `translate`, `vocabulary`) already redirects home when nothing
  is active. Profile's "learning" row shows "—" when nothing is active.

The low-confidence part: backing out of the invite screen without inviting anyone returns a new
tutor to `/enroll`. Two choices, learn or invite, are all that an empty account has. That seemed
honest, but it is a loop someone might find odd.

**D14. The tutor's side: students on home, one screen per student.**

- Home shows **My students** for an account that holds grants. There is one row per grant
  ("ויקטור · איטלקית"), and pending rows read "waiting for Victor to accept". A **Invite a student**
  button opens `/students/invite`.
- The invite screen has a username field and the target-language choices (`ENROLLABLE_TARGETS`).
  Each refusal in D9 gets its own message.
- Tapping an accepted row opens `/students/words?grant=<id>`: the lookup panel in tutor mode (D10),
  under a header "Adding words for Victor · Italian", with a "Stop tutoring Victor" link at the
  bottom, after a confirmation. Tapping a pending row offers "Cancel invite", after a
  confirmation.
- The app only ever offers a tutor the students on their accepted grants. Done-means 3's app half.

**D15. Grants travel with the user.** `CurrentUserProvider` fetches grants at login together with
enrollments, so home's redirect rule (D13) decides on both at once. It exposes `grants` and
`reloadGrants()`. Home calls `reloadGrants()` on focus, the way it already refreshes the next
session, so an accept on one phone shows on the other at the next visit home. A failed reload
keeps the last list.

**D16. The lookup screen is shared, not copied.** `app/translate.tsx` is 453 lines. Its body moves
to `components/LookupPanel.tsx`, and `TranslationProvider` takes an optional `list` prop
(`{ enrollmentId; sourceLanguage; targetLanguage; mode: 'learner' | 'tutor' }`). Without the prop
it derives the list from the active enrollment, as today. `students/words.tsx` nests its own
provider with the grant's list. Both modes send the actor header with `user.id`. The two screens
differ only in their headers.

**D17. Home is split before it grows.** `app/index.tsx` is 379 lines, and all of it assumes an
active enrollment. Its learning block moves to `components/LearningSection.tsx`, unchanged. Home
composes `InvitesSection`, `LearningSection` or the start-learning button, and `StudentsSection`.

**D18. ADR 0008, "Access grants", amends ADR 0005.** It records D1, D6, D7 and D8. Its checkable
rules:

| # | Rule | Check |
|---|---|---|
| R1 | `enrollment_grants` is read and written only by `repo/grants.ts` | `enrollment_grants` or `enrollmentGrants` in `apps/server/src` outside `repo/grants.ts` and `db/schema.ts` |
| R2 | The actor header is named once per app | `x-acting-user-id` (case-insensitive) in `apps/server/src` outside `routes/actor.ts`, or in `apps/mobile/src` outside `api/client.ts`, test files excepted |
| R3 | Roles are named once | the literal `'tutor'` in `apps/server/src` outside `domain/access.ts` and `db/schema.ts`, test files excepted |

The rules a script can't check:
- **R4:** every use case that acts on an enrollment for an actor calls `authorize`. Review enforces
  it, like ADR 0001 R9.
- **R5:** nothing treats the actor as authenticated. Superseding the header with login is a new ADR.

ADR 0005's status line gains "Amended by ADR 0008: authorization over an asserted identity". Its
rules stay unchanged: still no credential code. The check script is written violation-first, as
CLAUDE.md requires.

**D19. Logs.** `grant_invited`, `grant_accepted` and `grant_ended` (with `by: 'owner' |
'grantee'`, and `was: 'pending' | 'accepted'`) carry the grant id and the role. `access_denied`
carries the actor, the enrollment and the permission. `vocabulary_saved` gains `by: 'owner' |
'grantee'`. No usernames are logged: the ids are enough, and the same rule already holds for
learners.

---

## 2. Changes

### Data (migration `0018_enrollment_grants.sql`, renumbered at merge; see Risks)

```
enrollment_grants
  id                text pk default gen_random_uuid()::text
  enrollment_id     text not null
  owner_user_id     text not null
  grantee_user_id   text not null → users.id
  role              text not null   CHECK (role in ('tutor'))
  accepted_at       timestamptz null
  created_at        timestamptz not null default now()

  FK (owner_user_id, enrollment_id) → enrollments (user_id, id)    enrollments_user_id_id_key
  UNIQUE (enrollment_id, grantee_user_id)
  CHECK  (grantee_user_id <> owner_user_id)
  INDEX  (grantee_user_id)                    "the grants I hold"
  INDEX  (owner_user_id)                      "the grants on my lists"

vocabulary_entries
  + added_by_user_id text → users.id
    backfill: UPDATE … SET added_by_user_id = enrollments.user_id FROM enrollments …
    then SET NOT NULL.
```

### `packages/core`

- `schemas.ts`: `GrantSchema`, `GrantListSchema`, `CreateGrantRequestSchema`
  (`{ username: UsernameSchema, target_language: LanguageCodeSchema }`), the two `added_by` fields
  (D11). `types.ts` and `index.ts` export the inferred types.

### Server

- `db/schema.ts`: `enrollmentGrants`, and `addedByUserId` on `vocabularyEntries`.
- `domain/access.ts` (+ test): D6.
- `repo/grants.ts`: `insertGrant`, `findGrant(id)`, `findGrantFor(enrollmentId, granteeUserId)`,
  `acceptGrant(id)`, `deleteGrant(id)`, `listForOwner(userId)`, `listForGrantee(userId)`. The list
  reads join `users` and `enrollments` and return wire-shaped rows. Unique-violation mapping goes
  through `repo/pgErrors.ts`, as `UsernameTaken` does.
- `repo/enrollments.ts`: `findByUserAndTarget(userId, target)`.
- `repo/vocabulary.ts`: `insertEntries` takes `addedByUserId`. The list summaries and the detail's
  saved entries return the other adders' display names (D11).
- `services/access.ts`: `authorize` (D8). `services/grants.ts`: `createGrantService` with `invite`,
  `list`, `accept` and `end`, one transaction each.
- `services/vocabulary.ts`: `save(actorUserId, enrollmentId, entries)` and
  `unsave(actorUserId, enrollmentId, senseId)` call `authorize` after `enrollmentOrThrow`.
- `errors.ts`: `AccessDenied`, `GrantNotFound`, `GrantExists`, `NotLearning`, `OwnList`.
- `routes/actor.ts`: the header schema and its description. `routes/grants.ts`: D9.
  `routes/vocabulary.ts`: the header on save and unsave, and the 403.
- `services/transaction.ts` (`Repos.grant`), `composition.ts`, `app.ts`: wiring.
- `openapi.test.ts`: the header's description says it authenticates nothing.
- `docs/adr/adr-0008-access-grants.md`, `scripts/check-adr-0008-access-grants.sh`, and ADR 0005's
  status line (D18). ADR 0002 R6's factory list gains `createGrantRepo` and `createGrantService`.

### Mobile

- `api/client.ts`: the header helper; `saveVocabulary` and `unsaveVocabulary` take
  `actorUserId` first; `listGrants`, `createGrant`, `acceptGrant` and `endGrant`.
- `grants.ts` (+ test): pure helpers. `pendingInvites(grants)`, `myTutors(grants)`, `myStudents(grants)`,
  `needsEnrollScreen(enrollments, grants)` (D13), and `inviteErrorMessage(error)`.
- `hooks/useCurrentUser.tsx`: `grants`, `reloadGrants`, `acceptInvite`, `endGrant` and `invite`
  (D15).
- `hooks/useVocabulary.tsx` and every other caller of save or unsave: pass `user.id` as the actor.
- `hooks/useTranslation.tsx`: the `list` prop and tutor mode (D10, D16). The pure part, which
  senses are addable in tutor mode, is `addableStateOf(senses, from, targetLanguage)` in
  `vocabulary.ts` (+ test).
- `components/LookupPanel.tsx` (from `translate.tsx`), `components/LearningSection.tsx` (from
  `index.tsx`), `components/InvitesSection.tsx`, and `components/StudentsSection.tsx`.
- `app/index.tsx` (D13, D17), `app/enroll.tsx` (the teach button), `app/profile.tsx` (tutors,
  D12), `app/students/invite.tsx`, `app/students/words.tsx`, `app/vocabulary/index.tsx` and
  `app/vocabulary/word.tsx` (labels).
- `strings.ts`: every new string, in Hebrew.

## 3. Testing

### Unit
- `domain/access.test.ts`: `may` over owner × grantee × stranger × pending/accepted × each
  permission; `mayAnswerInvite`; `mayEndGrant`.
- Mobile: `api/client.test.ts` (the header is sent, with the given id, on exactly the calls that
  need it), `grants.test.ts`, `vocabulary.test.ts` (`addableStateOf`).
- `openapi.test.ts`: the four grant routes are published; the header's description.

### Integration (real Postgres)
- `repo/grants`: insert and read back; the unique and self-grant constraints; the composite FK
  refuses a grant whose owner does not own the enrollment; list reads both ways.
- `db`: the migration backfills `added_by_user_id` for existing rows to the owner.
- `services/grants`: invite → accept → end; each refusal in D9; a stranger can neither accept nor
  end.
- `services/vocabulary`: owner save still works, with `added_by` set to the owner; an accepted
  tutor's save lands with `added_by` set to the tutor; a pending tutor, a stranger, and a tutor
  whose grant is on the student's *other* language are each refused with `AccessDenied` and write
  nothing; a tutor's unsave is refused; first adder wins.
- **Done-means 2:** a sense a tutor added is planned into the student's next list session, and a
  right answer raises its level. This is a service test beside `sessions.progress.test.ts`.
- `routes/grants` and `routes/vocabulary`: the status codes and bodies of D8 and D9, including the
  400 without the header.

### E2E
`e2e/tests/tutor.spec.ts`, one flow:
1. a tutor account with no language is sent to `/enroll`, taps "I'm here to teach", and invites
   a Russian learner;
2. the learner logs in, sees the invite, and accepts it;
3. the tutor logs in, opens the student, looks up a word (MockServer), and adds it;
4. the learner opens the saved list, and the word reads "added by" the tutor;
5. the learner ends the link from profile, and the tutor's home no longer lists them.

### Architecture
`scripts/check-adr-0008-access-grants.sh`: for each rule, plant a violation, see it reported, and
remove it.

## Build order

1. Core schemas, the migration, `domain/access`.
2. `repo/grants`, the `insertEntries` change and the label reads.
3. `services/access`, `services/grants`, and the vocabulary service's check.
4. Routes, `routes/actor.ts`, wiring and the OpenAPI test.
5. ADR 0008, its check script, and the ADR 0005 and 0002 edits.
6. The mobile API client, `grants.ts`, and `useCurrentUser`.
7. The home split, `LearningSection`, the redirect rule, and the enroll teach button.
8. The invite screen, `StudentsSection`, and `InvitesSection`.
9. `LookupPanel`, tutor mode, and `students/words`.
10. The labels in the list and on the word's page, and profile's tutors.
11. E2E.

## Risks

- **Two phases in flight both add migration 0018.** Phase 26 adds `0018_photo_imports` and phase
  27 adds `0018_typed_meaning`. Whichever merges second renumbers. This phase's migration is
  self-contained, so a renumber is a rename plus the drizzle journal.
- **Phase 26 saves imported rows.** If it calls `insertEntries`, its call needs `addedByUserId` after
  this merges. The type change makes that a compile error, not a silent default.
- **The save and unsave header is a breaking wire change** for an app built before this phase. The
  app ships together with the server (Expo Go), so nothing old is in the field. The 400 says
  `invalid request`, which the app already treats as a failed save.
- **Home is the most-edited screen in the app.** The split (D17) moves code without changing it,
  and lands as its own commit before anything is added, so a regression points at one or the other.
