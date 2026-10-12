import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createGlossFamiliesRepo, type FamilyWrite } from '../../../src/repo/glossFamilies';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

/** Phase 39 (spec D4). The stored families: load, apply, and the cascades. */

let t: TestDb;
const E = enrollmentOf('u_1');
const SESSION = '00000000-0000-4000-8000-000000000039';
let glossIds: string[];

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  ({ glossIds } = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'pick up', translations: ['להרים', 'לאסוף'] }));
  await t.db.execute(sql`
    insert into sessions (id, user_id, enrollment_id, status, source) values (${SESSION}, 'u_1', ${E}, 'ready', 'list')`);
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createGlossFamiliesRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createGlossFamiliesRepo(tx)));

const KNOWN_AT = '2026-10-10T08:00:00.000Z';
const write = (over: Partial<FamilyWrite> = {}): FamilyWrite => ({
  families: [{ id: 'f1', label: 'pick up', isNew: true }],
  deleteFamilies: [],
  members: [
    { glossId: glossIds[0], familyId: 'f1', state: 'known', position: 0, knownAt: KNOWN_AT, sinceChanged: true },
    { glossId: glossIds[1], familyId: 'f1', state: 'current', position: 1, knownAt: null, sinceChanged: true },
  ],
  deleteMembers: [],
  events: [
    { familyId: 'f1', glossId: glossIds[0], fromState: null, toState: 'known', evidence: { live: ['written_receptive'], known_stability: 7 } },
  ],
  ...over,
});

describe('gloss_families repo (phase 39 D4)', () => {
  it('loads nothing for an enrollment without families', async () => {
    expect(await repo((r) => r.load(E))).toEqual([]);
  });

  it('round-trips families, members and known_at', async () => {
    await repo((r) => r.apply(E, SESSION, write()));
    const [family] = await repo((r) => r.load(E));
    expect(family).toEqual({
      id: 'f1',
      label: 'pick up',
      createdAt: expect.any(String),
      members: [
        { glossId: glossIds[0], familyId: 'f1', state: 'known', position: 0, knownAt: new Date(KNOWN_AT).toISOString() },
        { glossId: glossIds[1], familyId: 'f1', state: 'current', position: 1, knownAt: null },
      ],
    });
  });

  it('writes events with the session id and the evidence', async () => {
    await repo((r) => r.apply(E, SESSION, write()));
    const rows = await t.db.execute<{ session_id: string; from_state: string | null; to_state: string; evidence: unknown; at: string }>(
      sql`select session_id, from_state, to_state, evidence, at from gloss_family_events where enrollment_id = ${E}`,
    );
    expect(rows.rows).toEqual([
      { session_id: SESSION, from_state: null, to_state: 'known', evidence: { live: ['written_receptive'], known_stability: 7 }, at: expect.anything() },
    ]);
  });

  it('moves since only when sinceChanged, and updates a family and members in place', async () => {
    await repo((r) => r.apply(E, SESSION, write()));
    const since = async () =>
      (await t.db.execute<{ gloss_id: string; since: string }>(sql`select gloss_id, since::text from gloss_family_members order by position`)).rows;
    const before = await since();
    await repo((r) =>
      r.apply(E, SESSION, {
        families: [{ id: 'f1', label: 'pick up!', isNew: false }],
        deleteFamilies: [],
        members: [
          { glossId: glossIds[0], familyId: 'f1', state: 'known', position: 0, knownAt: KNOWN_AT, sinceChanged: false },
          { glossId: glossIds[1], familyId: 'f1', state: 'known', position: 1, knownAt: KNOWN_AT, sinceChanged: true },
        ],
        deleteMembers: [],
        events: [],
      }),
    );
    const after = await since();
    expect(after[0]).toEqual(before[0]);
    expect(after[1].since).not.toBe(before[1].since);
    const [family] = await repo((r) => r.load(E));
    expect(family.label).toBe('pick up!');
    expect(family.members.map((m) => m.state)).toEqual(['known', 'known']);
  });

  it('deletes members and families it is told to', async () => {
    await repo((r) => r.apply(E, SESSION, write()));
    await repo((r) => r.apply(E, SESSION, write({ families: [], members: [], events: [], deleteMembers: [glossIds[1]] })));
    expect((await repo((r) => r.load(E)))[0].members).toHaveLength(1);
    await repo((r) => r.apply(E, SESSION, write({ families: [], members: [], events: [], deleteMembers: [glossIds[0]], deleteFamilies: ['f1'] })));
    expect(await repo((r) => r.load(E))).toEqual([]);
  });

  it("drops a member's row with its vocabulary entry, and keeps the log", async () => {
    await repo((r) => r.apply(E, SESSION, write()));
    await t.db.execute(sql`delete from vocabulary_entries where enrollment_id = ${E} and gloss_id = ${glossIds[1]}`);
    expect((await repo((r) => r.load(E)))[0].members.map((m) => m.glossId)).toEqual([glossIds[0]]);
    const events = await t.db.execute(sql`select 1 from gloss_family_events`);
    expect(events.rows).toHaveLength(1);
  });

  it('drops its members with a family', async () => {
    await repo((r) => r.apply(E, SESSION, write()));
    await t.db.execute(sql`delete from gloss_families where id = 'f1'`);
    const rows = await t.db.execute(sql`select 1 from gloss_family_members`);
    expect(rows.rows).toEqual([]);
  });
});
