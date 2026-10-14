# ADR 0013: A learner's day comes from one place

- **Status:** Accepted
- **Date:** 2026-10-11; the learner's day is the date in their time zone, and `domain/learnerClock.ts` holds the formula 2026-10-14 (phase 52), R1–R3 unchanged
- **Source:** [phase 35 design](../superpowers/specs/2026-10-11-lang-tutor-phase-35-question-choosing-design.md) — D10 and D11 for the day and the bot's, D23 for these rules; [phase 52 design](../superpowers/specs/2026-10-14-lang-tutor-phase-52-practice-reminders-design.md) — D1 for the time zone

## Decision

The day a learner's progress counts for is computed in one function, `learnerDay` in
`services/learnerDay.ts`: the date of the clock in the learner's time zone (`users.time_zone`, an
IANA name the app reports on every launch, UTC until it does) for a learner, and the day the
profile is on for a bot. The formula for a learner is `dayInTimeZone` in `domain/learnerClock.ts`,
a pure function of the instant and the zone; `localMinutes` and `isoWeekday` there read the same
clock, so the reminder tick and the progress day cannot disagree about what hour or date it is
for a learner. A session records the day as `sessions.practice_day` in the transaction that ends
it, and the level rule, the memory update and the recompute all read that column. A bot plays on
a clock of its own (`users.bot_day`), so a second place deriving a date another way would quietly
break the bots' clock without failing anything else.

Rows written before phase 52 keep the UTC date they were given; there is no backfill.

```
  clock ──► learnerDay(repos, userId, now) ──► sessions.practice_day ──► level rule, memory, recompute
                    ▲
                    ├── domain/learnerClock.ts: dayInTimeZone   (a learner: users.time_zone)
                    └── repo/users.ts: findDayContext           (the only reader of users.bot_day)

  routes/bots.ts: the only route file that names kind = 'bot' or BOT_SECRET
```

## Rules

| # | Subject | Must | Must not |
|---|---|---|---|
| R1 | every non-test `.ts` file under `apps/server/src` except `services/learnerDay.ts` | — | compute a progress day: `AT TIME ZONE 'UTC')::date`, `.toISOString().slice(0, 10)` |
| R2 | every non-test `.ts` file under `apps/server/src` except `repo/users.ts`, `db/schema.ts` and `db/migrations/` | — | read or write `bot_day` |
| R3 | every non-test `.ts` file under `apps/server/src/routes` except `routes/bots.ts` | — | name `kind = 'bot'` or `BOT_SECRET` |

## How to detect a violation

`npm run lint:arch` runs the three commands below alongside the other ADRs';
`scripts/check-adr-0013-learner-day.sh` mirrors this block verbatim. Paste the block at the repo
root, then run `r1`, `r2` and `r3`: each must print nothing.

```bash
# R1 — only services/learnerDay.ts computes a progress day.
r1() { grep -rnE --include='*.ts' --exclude='*.test.ts' "AT TIME ZONE 'UTC'\)::date|\.toISOString\(\)\.slice\(0, ?10\)" apps/server/src | grep -v -e '^apps/server/src/services/learnerDay.ts:'; }

# R2 — bot_day is read or written only in repo/users.ts.
r2() { grep -rnE --include='*.ts' --exclude='*.test.ts' 'bot_day|botDay' apps/server/src | grep -v -e '^apps/server/src/repo/users.ts:' -e '^apps/server/src/db/schema.ts:' -e '^apps/server/src/db/migrations/'; }

# R3 — routes/bots.ts is the only route file that names the bot kind or its secret.
r3() { grep -rnE --include='*.ts' --exclude='*.test.ts' "kind = 'bot'|BOT_SECRET" apps/server/src/routes | grep -v -e '^apps/server/src/routes/bots.ts:'; }
```

### What the rules cover

- Scans `apps/server/src` for `.ts` files; R3 scans `apps/server/src/routes`. Test files
  (`*.test.ts`) are out, and so is `tests/`, which seeds bots and days directly.
- **The exceptions are the owners.** `db/schema.ts` must declare the `bot_day` column, so R2 skips
  it and `db/migrations/`, which is history. Every other exception is the file the rule names.
- The patterns are literal text: a day derived through another spelling of the date (a
  `date_trunc`, a `toISOString().split('T')`) is outside what R1 sees, and review catches it.
- `drizzle-kit` migrations are `.sql`, so no `--include='*.ts'` scan reads them in any case.

## Why

- **R1 looks like tidiness and is a data rule.** A bot's day is not the clock's, so one
  `toISOString().slice(0, 10)` in a service gives a bot learner's progress the wrong date.
- **R2 keeps the bot's clock readable in one place.** `findDayContext` hands out the day; a
  second reader could not tell a learner (no day of its own) from a bot whose day has not moved.
- **R3 keeps the bot door in one file.** The secret and the kind check live where the route that
  needs them lives, so a learner-facing route cannot grow a bot branch.

## Related

- [ADR 0001](adr-0001-layered-architecture.md) R3 — the domain is pure: the day is passed in.
- [ADR 0009](adr-0009-sign-in.md) R6 — `insert(users)` stays in `repo/users.ts`, where bot
  profiles are created too.
