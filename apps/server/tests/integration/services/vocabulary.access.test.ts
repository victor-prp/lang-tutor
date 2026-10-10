import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AccessDenied } from '../../../src/errors';
import type { VocabularyService } from '../../../src/services/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { addedByOf, seedGrant } from '../../support/grantRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 28 (spec D6–D8). Who may write to a list. The owner always; a tutor with
// an accepted grant may add and never remove; nobody else may do either.

let t: TestDb;
let logger: FakeLogger;
let vocabulary: VocabularyService;
const E = enrollmentOf('u_student'); // English
const RU = 'e_student_ru';

let kite: { glossIds: string[]; variantIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  await seedUser(t.db, 'u_student');
  await seedUser(t.db, 'u_tutor');
  await seedUser(t.db, 'u_stranger');
  await seedEnrollment(t.db, { id: RU, userId: 'u_student', targetLanguage: 'ru' });
  vocabulary = createTestServerDeps({ db: t.db, logger, rng: testRng(7) }).vocabulary;
  kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [{ senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null }],
      },
    ],
  });
});
afterEach(async () => {
  await t.close();
});

const entry = () => [{ gloss_id: kite.glossIds[0], variant_id: kite.variantIds[0] }];

describe('save', () => {
  it('lets the owner save, recorded as theirs', async () => {
    await vocabulary.save('u_student', E, entry());
    expect(await addedByOf(t.db, E)).toEqual(['u_student']);
  });

  it('lets an accepted tutor add, recorded as the tutor’s', async () => {
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_tutor', E, entry());
    expect(await addedByOf(t.db, E)).toEqual(['u_tutor']);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'vocabulary_saved', by: 'grantee' }));
  });

  it.each<[string, string, { enrollment: string; accepted: boolean } | null]>([
    ['a pending tutor', 'u_tutor', { enrollment: E, accepted: false }],
    ['a tutor of the student’s other language', 'u_tutor', { enrollment: RU, accepted: true }],
    ['a stranger', 'u_stranger', null],
  ])('refuses %s and writes nothing', async (_who, actor, held) => {
    if (held) {
      await seedGrant(t.db, { enrollmentId: held.enrollment, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: held.accepted });
    }
    await expect(vocabulary.save(actor, E, entry())).rejects.toBeInstanceOf(AccessDenied);
    expect(await addedByOf(t.db, E)).toEqual([]);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'access_denied', enrollment_id: E, permission: 'vocabulary.add' }),
    );
  });

  it('keeps the first adder when the tutor adds a sense the student already has', async () => {
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_student', E, entry());
    await vocabulary.save('u_tutor', E, entry());
    expect(await addedByOf(t.db, E)).toEqual(['u_student']);
  });
});

describe('unsave', () => {
  it('refuses a tutor, even an accepted one', async () => {
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_tutor', E, entry());
    await expect(vocabulary.unsave('u_tutor', E, kite.glossIds[0])).rejects.toBeInstanceOf(AccessDenied);
    expect(await addedByOf(t.db, E)).toEqual(['u_tutor']);
  });

  it('lets the owner remove a word the tutor added', async () => {
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_tutor', E, entry());
    await vocabulary.unsave('u_student', E, kite.glossIds[0]);
    expect(await addedByOf(t.db, E)).toEqual([]);
  });
});

// Phase 29 (spec D13). Reading the list is the owner's alone: phase 28's tutor
// adds words, and the tutor screen never reads the list it adds to.
describe('the reads', () => {
  const refused: [string, string, boolean][] = [
    ['a stranger', 'u_stranger', false],
    ['an accepted tutor', 'u_tutor', true],
  ];

  it.each(refused)('listWords refuses %s with AccessDenied, and the list is unchanged', async (_who, actor, granted) => {
    if (granted) await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_student', E, entry());
    await expect(vocabulary.listWords(actor, E, {})).rejects.toBeInstanceOf(AccessDenied);
    expect(await addedByOf(t.db, E)).toEqual(['u_student']);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'access_denied', actor_user_id: actor, enrollment_id: E, permission: 'vocabulary.read' }),
    );
  });

  it.each(refused)('wordDetail refuses %s with AccessDenied, and the list is unchanged', async (_who, actor, granted) => {
    if (granted) await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_student', E, entry());
    await expect(vocabulary.wordDetail(actor, E, 'kite')).rejects.toBeInstanceOf(AccessDenied);
    expect(await addedByOf(t.db, E)).toEqual(['u_student']);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'access_denied', actor_user_id: actor, enrollment_id: E, permission: 'vocabulary.read' }),
    );
  });

  it('lets the owner read their own list', async () => {
    await vocabulary.save('u_student', E, entry());
    expect((await vocabulary.listWords('u_student', E, {})).items).toHaveLength(1);
    expect((await vocabulary.wordDetail('u_student', E, 'kite')).senses).toHaveLength(1);
  });
});
