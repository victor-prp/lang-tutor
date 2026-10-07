import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AccessDenied, GrantExists, GrantNotFound, NotLearning, OwnList, UserNotFound } from '../../../src/errors';
import type { GrantService } from '../../../src/services/grants';
import type { VocabularyService } from '../../../src/services/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let logger: FakeLogger;
let grants: GrantService;
let vocabulary: VocabularyService;

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  await seedUser(t.db, 'u_student'); // English, as e_u_student
  await seedUser(t.db, 'u_tutor');
  await seedUser(t.db, 'u_stranger');
  await seedEnrollment(t.db, { id: 'e_student_ru', userId: 'u_student', targetLanguage: 'ru' });
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7) });
  grants = deps.grants;
  vocabulary = deps.vocabulary;
});
afterEach(async () => {
  await t.close();
});

const inviteRussian = () => grants.invite('u_tutor', { username: 'u_student', target_language: 'ru' });

describe('invite', () => {
  it('creates a pending tutor grant on the student’s list in that language', async () => {
    const grant = await inviteRussian();
    expect(grant).toMatchObject({
      role: 'tutor',
      status: 'pending',
      enrollment: { id: 'e_student_ru', target_language: 'ru' },
      owner: { id: 'u_student' },
      grantee: { id: 'u_tutor' },
    });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'grant_invited', grant_id: grant.id }));
  });

  it('refuses an unknown username', async () => {
    await expect(grants.invite('u_tutor', { username: 'nobody', target_language: 'ru' })).rejects.toBeInstanceOf(UserNotFound);
  });

  it('refuses a student who is not learning that language (spec D3)', async () => {
    await expect(grants.invite('u_tutor', { username: 'u_student', target_language: 'it' })).rejects.toBeInstanceOf(NotLearning);
  });

  it('refuses inviting yourself', async () => {
    await expect(grants.invite('u_student', { username: 'u_student', target_language: 'ru' })).rejects.toBeInstanceOf(OwnList);
  });

  it('refuses an actor who is not a user, and creates nothing', async () => {
    await expect(grants.invite('u_nobody', { username: 'u_student', target_language: 'ru' })).rejects.toBeInstanceOf(AccessDenied);
    expect(await grants.list('u_student')).toEqual({ tutors: [], students: [] });
  });

  it('refuses a second invite to the same list', async () => {
    await inviteRussian();
    await expect(inviteRussian()).rejects.toBeInstanceOf(GrantExists);
  });
});

describe('list', () => {
  it('shows each party its side', async () => {
    const grant = await inviteRussian();
    expect(await grants.list('u_student')).toEqual({ tutors: [grant], students: [] });
    expect(await grants.list('u_tutor')).toEqual({ tutors: [], students: [grant] });
    expect(await grants.list('u_stranger')).toEqual({ tutors: [], students: [] });
  });
});

describe('accept', () => {
  it('is the student’s, and lets the tutor add words afterwards', async () => {
    const grant = await inviteRussian();
    const accepted = await grants.accept('u_student', grant.id);
    expect(accepted).toMatchObject({ id: grant.id, status: 'accepted', accepted_at: expect.any(String) });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'grant_accepted', grant_id: grant.id }));
  });

  it('answers a second accept with the same accepted grant (Review Focus 4)', async () => {
    const grant = await inviteRussian();
    const first = await grants.accept('u_student', grant.id);
    expect(await grants.accept('u_student', grant.id)).toEqual(first);
  });

  it.each(['u_tutor', 'u_stranger'])('refuses %s', async (actor) => {
    const grant = await inviteRussian();
    await expect(grants.accept(actor, grant.id)).rejects.toBeInstanceOf(AccessDenied);
  });

  it('answers GrantNotFound for no such grant', async () => {
    await expect(grants.accept('u_student', 'g_missing')).rejects.toBeInstanceOf(GrantNotFound);
  });
});

describe('end', () => {
  it.each([
    ['the student declines', 'u_student', false, 'owner', 'pending'],
    ['the tutor cancels', 'u_tutor', false, 'grantee', 'pending'],
    ['the student ends it', 'u_student', true, 'owner', 'accepted'],
    ['the tutor stops', 'u_tutor', true, 'grantee', 'accepted'],
  ])('%s', async (_case, actor, accept, by, was) => {
    const grant = await inviteRussian();
    if (accept) await grants.accept('u_student', grant.id);
    await grants.end(actor as string, grant.id);
    expect(await grants.list('u_student')).toEqual({ tutors: [], students: [] });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'grant_ended', grant_id: grant.id, by, was }));
  });

  it('refuses a stranger', async () => {
    const grant = await inviteRussian();
    await expect(grants.end('u_stranger', grant.id)).rejects.toBeInstanceOf(AccessDenied);
  });

  it('is a no-op for no such grant', async () => {
    await expect(grants.end('u_student', 'g_missing')).resolves.toBeUndefined();
  });

  it('stops the tutor adding words once the student ends it (Review Focus 1)', async () => {
    const word = await insertLexeme(t.db, {
      lemma: 'рама',
      languageCode: 'ru',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'first' }],
      variants: [
        {
          form: 'рама',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'first', rank: 0, translation: 'рама-1', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const entries = [{ sense_id: word.senseIds[0], variant_id: word.variantIds[0] }];
    const grant = await inviteRussian();
    await grants.accept('u_student', grant.id);
    await expect(vocabulary.save('u_tutor', 'e_student_ru', entries)).resolves.toEqual({
      saved_sense_ids: [word.senseIds[0]],
    });
    await grants.end('u_student', grant.id);
    await expect(vocabulary.save('u_tutor', 'e_student_ru', entries)).rejects.toBeInstanceOf(AccessDenied);
  });
});
