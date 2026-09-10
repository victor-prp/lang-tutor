import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createServerDeps } from '../../src/composition';
import { createFakeLogger } from '../support/fakes';
import { createTestServerDeps } from '../support/serverDeps';
import { seedUser } from '../support/seedUser';
import { createTestDb, type TestDb } from '../support/testDb';
import { testRng } from '../support/testRng';
import { insertTerm } from '../support/vocabRows';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});

afterEach(async () => {
  await t.close();
});

// The seam proof for the wiring layer itself: production's assembly, called with
// a per-test database and a fake logger — no socket, no environment.
describe('createServerDeps', () => {
  // The one call in the suite that names createServerDeps directly, with its
  // real argument list. Everywhere else goes through createTestServerDeps, so
  // without this the helper would be the only thing the signature is checked
  // against — and a parameter it stopped passing would go unnoticed.
  it('passes the logger it is given straight through', () => {
    const logger = createFakeLogger();
    const deps = createServerDeps({
      db: t.db,
      logger,
      rng: testRng(7),
      fetch: globalThis.fetch,
      gemini: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9/never-registered', model: 'm' },
    });
    expect(deps.logger).toBe(logger);
  });

  it('assembles a health repo bound to the database it is given', async () => {
    const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    expect(await deps.health.ping()).toBe(true);
  });

  it('assembles a session service that works against that database', async () => {
    const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    const { record } = await deps.sessions.startSession('u_1');
    expect(record.questions).toHaveLength(SESSION_LENGTH);
  });

  it('assembles a translations service that reads the database, not the provider', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [
        {
          rank: 0,
          senseCode: 'climbing_frame',
          translation: 'סולם',
          partOfSpeech: 'noun',
          exampleSource: null,
          exampleTarget: null,
        },
      ],
    });

    // createTestServerDeps defaults geminiBaseUrl to an unroutable namespace,
    // so an answer here can only have come from Postgres — which is the proof
    // that the service received a transaction at all.
    const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });

    await expect(deps.translations.translate({ text: 'Ladder' })).resolves.toMatchObject({
      kind: 'word',
      senses: [{ translation: 'סולם', part_of_speech: 'noun' }],
    });
  });
});
