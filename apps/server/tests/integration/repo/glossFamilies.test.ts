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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A new family, under the placeholder its members and events name too. */
const write = (over: Partial<FamilyWrite> = {}): FamilyWrite => ({
  families: [{ id: 'new:0', label: 'pick up', isNew: true }],
  deleteFamilies: [],
  members: [
    { glossId: glossIds[0], familyId: 'new:0', state: 'known', position: 0, knownAt: KNOWN_AT, sinceChanged: true },
    { glossId: glossIds[1], familyId: 'new:0', state: 'current', position: 1, knownAt: null, sinceChanged: true },
  ],
  deleteMembers: [],
  events: [
    { familyId: 'new:0', glossId: glossIds[0], fromState: null, toState: 'known', evidence: { live: ['written_receptive'], known_stability: 7 } },
  ],
  ...over,
});
/** Applies `write()`, and answers the id the database gave its family. */
async function created(): Promise<string> {
  await repo((r) => r.apply(E, SESSION, write()));
  return (await repo((r) => r.load(E)))[0].id;
}

describe('gloss_families repo (phase 39 D4)', () => {
  it('loads nothing for an enrollment without families', async () => {
    expect(await repo((r) => r.load(E))).toEqual([]);
  });

  it('round-trips families, members and known_at, a new family under an id the database made', async () => {
    const id = await created();
    expect(id).toMatch(UUID);
    const [family] = await repo((r) => r.load(E));
    expect(family).toEqual({
      id,
      label: 'pick up',
      createdAt: expect.any(String),
      members: [
        { glossId: glossIds[0], familyId: id, state: 'known', position: 0, knownAt: new Date(KNOWN_AT).toISOString() },
        { glossId: glossIds[1], familyId: id, state: 'current', position: 1, knownAt: null },
      ],
    });
  });

  it('writes events with the session id, the real family id and the evidence', async () => {
    const id = await created();
    const rows = await t.db.execute<{ family_id: string; session_id: string; from_state: string | null; to_state: string; evidence: unknown; at: string }>(
      sql`select family_id, session_id, from_state, to_state, evidence, at from gloss_family_events where enrollment_id = ${E}`,
    );
    expect(rows.rows).toEqual([
      { family_id: id, session_id: SESSION, from_state: null, to_state: 'known', evidence: { live: ['written_receptive'], known_stability: 7 }, at: expect.anything() },
    ]);
  });

  it('gives each new family of one write its own id', async () => {
    const blowUp = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'blow up', translations: ['לפוצץ', 'להגדיל'] });
    const join = (glossId: string, familyId: string, position: number) =>
      ({ glossId, familyId, state: 'waiting', position, knownAt: null, sinceChanged: true }) as const;
    await repo((r) =>
      r.apply(E, SESSION, {
        families: [
          { id: 'new:0', label: 'pick up', isNew: true },
          { id: 'new:1', label: 'blow up', isNew: true },
        ],
        deleteFamilies: [],
        members: [join(glossIds[0], 'new:0', 0), join(glossIds[1], 'new:0', 1), join(blowUp.glossIds[0], 'new:1', 0), join(blowUp.glossIds[1], 'new:1', 1)],
        deleteMembers: [],
        events: [{ familyId: 'new:1', glossId: blowUp.glossIds[0], fromState: null, toState: 'waiting', evidence: {} }],
      }),
    );
    const families = await repo((r) => r.load(E));
    const byLabel = new Map(families.map((family) => [family.label, family]));
    const [pickUp, blow] = [byLabel.get('pick up')!, byLabel.get('blow up')!];
    expect(pickUp.id).toMatch(UUID);
    expect(blow.id).toMatch(UUID);
    expect(pickUp.id).not.toBe(blow.id);
    expect(pickUp.members.map((m) => [m.glossId, m.familyId])).toEqual([[glossIds[0], pickUp.id], [glossIds[1], pickUp.id]]);
    expect(blow.members.map((m) => [m.glossId, m.familyId])).toEqual([[blowUp.glossIds[0], blow.id], [blowUp.glossIds[1], blow.id]]);
    const events = await t.db.execute<{ family_id: string }>(sql`select family_id from gloss_family_events`);
    expect(events.rows).toEqual([{ family_id: blow.id }]);
  });

  it('moves since only when sinceChanged, and updates a family and members in place', async () => {
    const id = await created();
    const since = async () =>
      (await t.db.execute<{ gloss_id: string; since: string }>(sql`select gloss_id, since::text from gloss_family_members order by position`)).rows;
    const before = await since();
    await repo((r) =>
      r.apply(E, SESSION, {
        families: [{ id, label: 'pick up!', isNew: false }],
        deleteFamilies: [],
        members: [
          { glossId: glossIds[0], familyId: id, state: 'known', position: 0, knownAt: KNOWN_AT, sinceChanged: false },
          { glossId: glossIds[1], familyId: id, state: 'known', position: 1, knownAt: KNOWN_AT, sinceChanged: true },
        ],
        deleteMembers: [],
        events: [],
      }),
    );
    const after = await since();
    expect(after[0]).toEqual(before[0]);
    expect(after[1].since).not.toBe(before[1].since);
    const [family] = await repo((r) => r.load(E));
    expect(family.id).toBe(id);
    expect(family.label).toBe('pick up!');
    expect(family.members.map((m) => m.state)).toEqual(['known', 'known']);
  });

  it('deletes members and families it is told to', async () => {
    const id = await created();
    await repo((r) => r.apply(E, SESSION, write({ families: [], members: [], events: [], deleteMembers: [glossIds[1]] })));
    expect((await repo((r) => r.load(E)))[0].members).toHaveLength(1);
    await repo((r) => r.apply(E, SESSION, write({ families: [], members: [], events: [], deleteMembers: [glossIds[0]], deleteFamilies: [id] })));
    expect(await repo((r) => r.load(E))).toEqual([]);
  });

  it("drops a member's row with its vocabulary entry, and keeps the log", async () => {
    await created();
    await t.db.execute(sql`delete from vocabulary_entries where enrollment_id = ${E} and gloss_id = ${glossIds[1]}`);
    expect((await repo((r) => r.load(E)))[0].members.map((m) => m.glossId)).toEqual([glossIds[0]]);
    const events = await t.db.execute(sql`select 1 from gloss_family_events`);
    expect(events.rows).toHaveLength(1);
  });

  it('drops its members with a family', async () => {
    const id = await created();
    await t.db.execute(sql`delete from gloss_families where id = ${id}`);
    const rows = await t.db.execute(sql`select 1 from gloss_family_members`);
    expect(rows.rows).toEqual([]);
  });
});
