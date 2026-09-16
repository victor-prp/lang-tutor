import { afterEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb, type Db } from '../../../src/db/client';
import { ensureDatabase } from '../../../src/db/ensureDatabase';
import { dropLaneDatabases, listLaneDatabases } from '../../../src/db/lanes';
import { ADMIN_URL, urlFor } from '../../support/dbNames';

const LANE = 'lanes_probe';
const MADE = [
  `lang_tutor_${LANE}`,
  `lang_tutor_e2e_${LANE}`,
  `t_${LANE}_tmpl_1`,
  `t_${LANE}_test_a_0badc0de`,
];

const STAMP = {
  lane: LANE,
  slot: '8',
  port: '11001',
  root: '/tmp/worktrees/lanes-probe',
  branch: 'feature/lanes-probe',
};

async function admin<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const handle = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  try {
    return await fn(handle.db);
  } finally {
    await handle.close();
  }
}

async function createAll(): Promise<void> {
  await ensureDatabase(urlFor(MADE[0]), STAMP);
  await admin(async (db) => {
    for (const name of MADE.slice(1)) {
      await db.execute(sql.raw(`create database ${name}`));
    }
  });
}

afterEach(async () => {
  await admin(async (db) => {
    for (const name of MADE) {
      await db.execute(sql.raw(`drop database if exists ${name} with (force)`));
    }
  });
});

describe('listLaneDatabases', () => {
  it('reports each lane database with the stamp that says who owns it', async () => {
    await createAll();
    const rows = await admin(listLaneDatabases);
    const dev = rows.find((row) => row.name === `lang_tutor_${LANE}`);
    expect(dev).toBeDefined();
    expect(dev?.comment).toContain(`lane=${LANE}`);
    expect(dev?.comment).toContain('branch=feature/lanes-probe');
  });

  it('includes lane 0 and the e2e database, and excludes the per-test databases', async () => {
    await createAll();
    const names = (await admin(listLaneDatabases)).map((row) => row.name);
    expect(names).toContain('lang_tutor');
    expect(names).toContain(`lang_tutor_e2e_${LANE}`);
    // Per-test databases are the harness's business and would drown the list —
    // a single integration run leaves upwards of a hundred.
    expect(names).not.toContain(`t_${LANE}_test_a_0badc0de`);
  });
});

describe('dropLaneDatabases', () => {
  it('drops the dev, e2e and per-test databases of one lane and nothing else', async () => {
    await createAll();
    const dropped = await admin((db) => dropLaneDatabases(db, LANE));
    expect(dropped.sort()).toEqual([...MADE].sort());

    const left = await admin((db) =>
      db.execute<{ datname: string }>(
        sql`select datname from pg_database where datname like ${'%' + LANE + '%'}`,
      ),
    );
    expect(left.rows).toEqual([]);

    // The shared dictionary database is somebody's working data.
    const zero = await admin((db) =>
      db.execute<{ datname: string }>(
        sql`select datname from pg_database where datname = 'lang_tutor'`,
      ),
    );
    expect(zero.rows).toHaveLength(1);
  });

  it('reports nothing for a lane that has no databases', async () => {
    expect(await admin((db) => dropLaneDatabases(db, 'never_existed'))).toEqual([]);
  });

  it('refuses lane 0 and an empty name, which would take the shared databases', async () => {
    await expect(admin((db) => dropLaneDatabases(db, 'main'))).rejects.toThrow('lane 0');
    await expect(admin((db) => dropLaneDatabases(db, ''))).rejects.toThrow('lane name');
  });
});
