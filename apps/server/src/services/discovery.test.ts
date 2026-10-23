import { describe, expect, it } from '@jest/globals';
import type { Enrollment, TranslationRequest, TranslationResponse, User } from '@lang-tutor/core/api';

import { DISCOVERY_MARKER } from '../domain/discovery';
import { LOOK_UP_DISCOVERED_WORD, STOCK_SESSION } from '../domain/jobs';
import { AccessDenied, DiscoveryConflict, DiscoveryNotFound, InvalidDiscoveryAnswer, LlmUnavailable, SenseMatchUnreadable } from '../errors';
import type { DictRepo } from '../repo/dictionary';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GlossRepo } from '../repo/glosses';
import type { GrantRepo } from '../repo/grants';
import type { UserRepo } from '../repo/users';
import type { VocabularyRepo } from '../repo/vocabulary';
import {
  createFakeClock,
  createFakeDiscoveryRepo,
  createFakeJobRepo,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  newCardRow,
  stub,
  type FakeDiscoveryRepo,
} from '../../tests/support/fakes';
import { createDiscoveryService } from './discovery';
import type { LlmJsonRequest } from './llm';
import type { Repos } from './transaction';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const OWNER = 'u_owner';
const ENROLLMENT = { id: 'e1', user_id: OWNER, source_language: 'he', target_language: 'it' } as Enrollment;
const WRONG = ['כלב', 'בית', 'ספר'];

type Reply = string | Error | ((request: LlmJsonRequest) => string | Promise<string>);
const proposal = (word: string, hebrew = `ע${word}`, alternatives: string[] = [], wrong = WRONG) => ({
  word,
  part_of_speech: 'noun',
  hebrew,
  alternatives,
  wrong,
});
const roundOf = (...words: (string | ReturnType<typeof proposal>)[]) =>
  JSON.stringify({ words: words.map((word) => (typeof word === 'string' ? proposal(word) : word)) });
const TEN = ['uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];

const option = (n: number) => ({ gloss_id: `g${n}`, variant_id: `v${n}`, translation: `t${n}` });
const lookupAnswer = (translations: string[]): TranslationResponse =>
  ({
    kind: 'word',
    senses: translations.map((translation, index) => ({ ...option(index + 1), translation, gloss_id: `g${index + 1}`, variant_id: `v${index + 1}` })),
  }) as unknown as TranslationResponse;

function setup(
  opts: {
    profileLevel?: number | null;
    discover?: Reply[];
    match?: Reply[];
    saved?: string[];
    discoverCount?: number | null;
    repos?: Partial<Repos>;
    lookup?: (actorUserId: string, input: TranslationRequest) => Promise<TranslationResponse>;
  } = {},
) {
  const repo = createFakeDiscoveryRepo();
  if (opts.profileLevel !== null) {
    repo.profiles.set('e1', { enrollmentId: 'e1', selfLevel: 'simple', learningContext: 'school', level: opts.profileLevel ?? 5 });
  }
  const discover = createFakeLlmClient(...(opts.discover ?? [roundOf(...TEN)]));
  const llm = createFakeLlmClient(...(opts.match ?? ['{"sense":0}']));
  const jobs = createFakeJobRepo();
  const logger = createFakeLogger();
  // What the saves wrote to My words, each save's entries.
  const inserted: { glossId: string; variantId: string }[][] = [];
  const transaction = createFakeTransaction({
    discovery: repo,
    jobs,
    enrollment: stub<EnrollmentRepo>({ findById: async (id: string) => (id === 'e1' ? ENROLLMENT : undefined) }),
    grant: stub<GrantRepo>({ findGrantFor: async () => null }),
    user: stub<UserRepo>({
      findById: async () => ({ id: OWNER, age: 34 }) as User,
      findNewWordLimits: async () => ({ dayCap: null, perSession: null, discoverCount: opts.discoverCount ?? null }),
    }),
    gloss: stub<GlossRepo>({
      resolveGlosses: async (ids: string[]) => new Map(ids.map((glossId) => [glossId, { id: glossId, userLanguageCode: 'he' }])),
    } as Partial<GlossRepo>),
    vocabulary: stub<VocabularyRepo>({
      savedLemmas: async () => opts.saved ?? ['casa'],
      findSaveable: async (input) => input.entries.map((entry) => ({ ...entry, lexemeId: `l${entry.glossId}`, lemma: entry.glossId })),
      insertEntries: async (input) => {
        inserted.push(input.entries.map((entry) => ({ glossId: entry.glossId, variantId: entry.variantId })));
      },
    }),
    dict: stub<DictRepo>({ claimLemmaRenders: async () => [] }),
    ...opts.repos,
  });
  const service = createDiscoveryService({
    transaction,
    discover,
    llm,
    lookup:
      opts.lookup ??
      (async (): Promise<TranslationResponse> => {
        throw new Error('no lookup in these tests');
      }),
    now: createFakeClock(NOW),
    // Fisher–Yates with 0 moves the right meaning last: choices[3].
    rng: () => 0,
    logger,
  });
  return { service, repo, discover, llm, jobs, logger, inserted };
}

/** A run of `rounds` rounds of ten cards each, the last round's last cards left unanswered
 *  when `answeredInLast` is under ten; `knownPerRound` of each answered round picked right and
 *  not added, the rest "אין לי מושג" and added, their lookups pending. */
async function seedRun(
  repo: FakeDiscoveryRepo,
  input: { goal?: number; rounds: number; answeredInLast?: number; knownPerRound?: number; status?: 'asking' | 'saved'; startedBy?: 'learner' | 'app' },
): Promise<string> {
  const run = (await repo.insertRun({ enrollmentId: 'e1', goal: input.goal ?? 15, startedBy: input.startedBy ?? 'learner' }))!;
  for (let round = 1; round <= input.rounds; round += 1) {
    const base = (round - 1) * 10;
    await repo.insertCards(
      run.id,
      TEN.map((word, index) => ({
        position: base + index,
        round,
        level: 5,
        word: `${word}${round}`,
        partOfSpeech: 'noun',
        hebrew: 'משהו',
        alternatives: [],
        choices: ['משהו', ...WRONG],
        rightChoice: 0,
      })),
    );
    const answered = round === input.rounds ? (input.answeredInLast ?? 10) : 10;
    for (let index = 0; index < answered; index += 1) {
      const known = index < (input.knownPerRound ?? 5);
      await repo.answerCard(run.id, base + index, {
        answer: known ? 'choice' : 'unknown',
        picked: known ? 0 : null,
        suggested: known ? 'skip' : 'add',
        added: !known,
        known,
        lookupStatus: known ? null : 'pending',
        answeredAt: new Date(NOW - (1000 - base - index)),
      });
    }
  }
  if (input.rounds > 1) await repo.setSettledRound(run.id, input.rounds - 1);
  if (input.status === 'saved') await repo.transition(run.id, ['asking'], 'saved');
  return run.id;
}

const userJson = (request: LlmJsonRequest) => JSON.parse(request.user) as Record<string, unknown>;
const stocks = (jobs: ReturnType<typeof createFakeJobRepo>) => jobs.enqueued.filter((job) => job.name === STOCK_SESSION);

describe('the profile (phase 69, spec D2, D3)', () => {
  it('writes the two answers once, with the level they start at', async () => {
    const { service, repo } = setup({ profileLevel: null });
    expect(await service.createProfile(OWNER, 'e1', { self_level: 'everyday', learning_context: 'course' })).toEqual({
      self_level: 'everyday',
      learning_context: 'course',
      level: 5,
    });
    expect(repo.profiles.get('e1')?.level).toBe(5);
    await expect(service.createProfile(OWNER, 'e1', { self_level: 'none', learning_context: 'self' })).rejects.toBeInstanceOf(
      DiscoveryConflict,
    );
  });

  it("refuses another learner's enrollment", async () => {
    const { service } = setup({ profileLevel: null });
    await expect(service.createProfile('u_stranger', 'e1', { self_level: 'none', learning_context: 'self' })).rejects.toBeInstanceOf(
      AccessDenied,
    );
  });

  it('answers no profile and no run before the questions', async () => {
    const { service } = setup({ profileLevel: null });
    expect(await service.state(OWNER, 'e1')).toEqual({ profile: null, run: null });
  });
});

describe('starting a run (phase 74, spec D6)', () => {
  it('refuses a run before the questions', async () => {
    const { service } = setup({ profileLevel: null });
    await expect(service.start(OWNER, 'e1', 15)).rejects.toBeInstanceOf(DiscoveryConflict);
  });

  it("starts the learner's run with the goal they chose, asking, with no cards yet and no call", async () => {
    const { service, discover } = setup();
    const { run, created } = await service.start(OWNER, 'e1', 15);
    expect(created).toBe(true);
    expect(run).toEqual({ id: run.id, goal: 15, status: 'asking', started_by: 'learner', added_count: 0, round: 0, cards: [], added: [] });
    expect(discover.calls).toHaveLength(0);
  });

  it("starts the app's run with the learner's count, 10 by default", async () => {
    expect((await setup().service.start(OWNER, 'e1', null)).run).toMatchObject({ goal: 10, started_by: 'app' });
    expect((await setup({ discoverCount: 20 }).service.start(OWNER, 'e1', null)).run).toMatchObject({ goal: 20, started_by: 'app' });
  });

  it('answers the open run instead of a second one', async () => {
    const { service } = setup();
    const first = await service.start(OWNER, 'e1', 10);
    const again = await service.start(OWNER, 'e1', null);
    expect(again).toMatchObject({ created: false, run: { id: first.run.id, goal: 10, started_by: 'learner' } });
    expect((await service.state(OWNER, 'e1')).run?.id).toBe(first.run.id);
  });
});

describe('a round (phase 69, spec D3, D4, D8; phase 74 D4)', () => {
  it("asks the model for a run's first round at the profile's level, leaving out every word the learner has", async () => {
    const { service, repo, discover } = setup({ saved: ['casa'] });
    repo.answeredElsewhere.push('gatto');
    const { run } = await service.start(OWNER, 'e1', 15);
    const next = await service.nextRound(OWNER, run.id);

    expect(discover.calls).toHaveLength(1);
    expect(discover.calls[0].system).toContain(DISCOVERY_MARKER);
    expect(discover.calls[0].record).toEqual({ kind: 'discovery', enrollmentId: 'e1', userId: OWNER });
    expect(userJson(discover.calls[0])).toMatchObject({ level: 'B1 lower', age: 34, learning_context: 'school', exclude: ['gatto', 'casa'] });
    expect(next.round).toBe(1);
    expect(repo.cards.get(run.id)?.every((card) => card.round === 1 && card.level === 5)).toBe(true);
  });

  it('writes each card with its four meanings shuffled, and sends which one is right', async () => {
    const { service, repo } = setup({ discover: [roundOf(proposal('finestra', 'חלון', [], ['דלת', 'וילון', 'מרפסת']))] });
    const { run } = await service.start(OWNER, 'e1', 15);
    const next = await service.nextRound(OWNER, run.id);
    expect(next.cards).toEqual([{ position: 0, word: 'finestra', choices: ['דלת', 'וילון', 'מרפסת', 'חלון'], right: 3 }]);
    expect(repo.cards.get(run.id)?.[0]).toMatchObject({ choices: ['דלת', 'וילון', 'מרפסת', 'חלון'], rightChoice: 3, hebrew: 'חלון' });
  });

  it('moves the level by the round that closed, once, and asks the next round there', async () => {
    const { service, repo, discover } = setup({ discover: [roundOf('primo', 'secondo')] });
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 8 });
    const next = await service.nextRound(OWNER, id);

    expect(repo.profiles.get('e1')?.level).toBe(7);
    expect(repo.runs.get(id)?.settledRound).toBe(1);
    expect(userJson(discover.calls[0])).toMatchObject({ level: 'B2 lower' });
    // This run's words come first: they are the newest.
    expect((userJson(discover.calls[0]).exclude as string[]).slice(0, 2)).toEqual(['dieci1', 'nove1']);
    expect(next).toMatchObject({ round: 2, cards: [{ position: 10, word: 'primo' }, { position: 11, word: 'secondo' }] });
    expect(repo.cards.get(id)?.filter((card) => card.round === 2).map((card) => card.level)).toEqual([7, 7]);
  });

  it('answers the run as it is while a card is unanswered, with no call', async () => {
    const { service, repo, discover } = setup();
    const id = await seedRun(repo, { rounds: 1, answeredInLast: 9 });
    const next = await service.nextRound(OWNER, id);
    expect(discover.calls).toHaveLength(0);
    expect(next.cards).toEqual([{ position: 9, word: 'dieci1', choices: ['משהו', ...WRONG], right: 0 }]);
  });

  it('writes nothing when another round landed during the call', async () => {
    const { service, repo } = setup({
      discover: [
        () => {
          const id = [...repo.runs.keys()][0];
          repo.cards
            .get(id)!
            .push(
              newCardRow(id, { position: 10, round: 2, level: 5, word: 'altro', partOfSpeech: 'noun', hebrew: 'אחר', alternatives: [], choices: ['אחר', ...WRONG], rightChoice: 0 }),
            );
          return roundOf('primo');
        },
      ],
    });
    const id = await seedRun(repo, { rounds: 1 });
    const next = await service.nextRound(OWNER, id);
    expect(next.cards.map((card) => card.word)).toEqual(['altro']);
    expect(repo.cards.get(id)).toHaveLength(11);
    expect(repo.runs.get(id)?.settledRound).toBe(0);
  });

  it('ends the run after the eighth round, settled, with no call', async () => {
    const { service, repo, discover, logger } = setup();
    const id = await seedRun(repo, { rounds: 8, knownPerRound: 10 });
    const next = await service.nextRound(OWNER, id);
    expect(discover.calls).toHaveLength(0);
    expect(next).toMatchObject({ status: 'saved', cards: [] });
    expect(repo.runs.get(id)?.settledRound).toBe(8);
    expect(repo.profiles.get('e1')?.level).toBe(7);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'discovery_ended', run_id: id, reason: 'rounds' }));
  });

  it('ends the run when the model has no word left', async () => {
    const { service, repo } = setup({ discover: [roundOf('casa')], saved: ['casa'] });
    const id = await seedRun(repo, { rounds: 1 });
    expect(await service.nextRound(OWNER, id)).toMatchObject({ status: 'saved', round: 1 });
  });

  it('throws LlmUnavailable on an empty answer, a refusal, and the run asks on', async () => {
    const { service, repo } = setup({ discover: [''] });
    const id = await seedRun(repo, { rounds: 1 });
    await expect(service.nextRound(OWNER, id)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(repo.runs.get(id)?.status).toBe('asking');
    expect(repo.cards.get(id)).toHaveLength(10);
  });

  it('throws LlmUnavailable on an answer that is not the schema, writing nothing', async () => {
    const { service, repo } = setup({ discover: ['{"items":[]}'] });
    const { run } = await service.start(OWNER, 'e1', 15);
    await expect(service.nextRound(OWNER, run.id)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(repo.cards.get(run.id)).toEqual([]);
  });

  it('answers DiscoveryNotFound for a run that does not exist', async () => {
    const { service } = setup();
    await expect(service.nextRound(OWNER, 'nope')).rejects.toBeInstanceOf(DiscoveryNotFound);
  });
});

describe('an answer (phase 74, spec D2, D3, D5)', () => {
  // The first card is gatto, חתול; rng 0 puts the right meaning at 3.
  async function oneRound(over: Parameters<typeof setup>[0] = {}, goal = 15) {
    const env = setup({ discover: [roundOf(proposal('gatto', 'חתול'), ...TEN.slice(1))], ...over });
    const { run } = await env.service.start(OWNER, 'e1', goal);
    await env.service.nextRound(OWNER, run.id);
    return { ...env, id: run.id };
  }

  it('takes a right pick not added as known, suggesting not to add, with no lookup', async () => {
    const { service, repo, jobs, logger, id } = await oneRound();
    const run = await service.answer(OWNER, id, 0, { pick: 3, add: false });
    expect(run).toMatchObject({ added_count: 0, added: [] });
    expect(run.cards.map((card) => card.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(repo.cards.get(id)?.[0]).toMatchObject({ answer: 'choice', picked: 3, suggested: 'skip', added: false, known: true, lookupStatus: null });
    expect(jobs.enqueued).toEqual([]);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'discovery_answered', run_id: id, position: 0, pick_right: true, added: false, suggested: 'skip', known: true }),
    );
  });

  it('takes a wrong pick added as not known, suggesting to add, and starts its lookup', async () => {
    const { service, repo, jobs, id } = await oneRound();
    const run = await service.answer(OWNER, id, 0, { pick: 1, add: true });
    expect(run).toMatchObject({ added_count: 1, added: [{ position: 0, word: 'gatto', meaning: 'חתול', status: 'pending' }] });
    expect(repo.cards.get(id)?.[0]).toMatchObject({ answer: 'choice', picked: 1, suggested: 'add', added: true, known: false, lookupStatus: 'pending' });
    expect(jobs.enqueued).toEqual([{ name: LOOK_UP_DISCOVERED_WORD, data: { run_id: id, position: 0 } }]);
  });

  it('takes "אין לי מושג" as not known, suggesting to add', async () => {
    const { service, repo, id } = await oneRound();
    await service.answer(OWNER, id, 0, { pick: null, add: true });
    expect(repo.cards.get(id)?.[0]).toMatchObject({ answer: 'unknown', picked: null, suggested: 'add', added: true, known: false });
  });

  it('counts a right pick the learner adds anyway as not known for the level', async () => {
    const { service, repo, jobs, id } = await oneRound();
    await service.answer(OWNER, id, 0, { pick: 3, add: true });
    expect(repo.cards.get(id)?.[0]).toMatchObject({ suggested: 'skip', added: true, known: false, lookupStatus: 'pending' });
    expect(jobs.enqueued).toHaveLength(1);
  });

  it('takes a wrong pick not added as not known, with no lookup', async () => {
    const { service, repo, jobs, id } = await oneRound();
    const run = await service.answer(OWNER, id, 0, { pick: 0, add: false });
    expect(run.added_count).toBe(0);
    expect(repo.cards.get(id)?.[0]).toMatchObject({ suggested: 'add', added: false, known: false, lookupStatus: null });
    expect(jobs.enqueued).toEqual([]);
  });

  it('refuses a pick past the card\'s choices, writing nothing', async () => {
    const { service, repo, id } = await oneRound();
    const card = repo.cards.get(id)![0];
    card.choices = card.choices.slice(0, 3);
    await expect(service.answer(OWNER, id, 0, { pick: 3, add: false })).rejects.toBeInstanceOf(InvalidDiscoveryAnswer);
    expect(repo.cards.get(id)?.[0].answer).toBeNull();
  });

  it('answers a card answered before with the run, its first answer standing and no second lookup', async () => {
    const { service, repo, jobs, id } = await oneRound();
    await service.answer(OWNER, id, 0, { pick: 1, add: true });
    const again = await service.answer(OWNER, id, 0, { pick: 3, add: false });
    expect(again.added_count).toBe(1);
    expect(repo.cards.get(id)?.[0]).toMatchObject({ picked: 1, added: true });
    expect(jobs.enqueued).toHaveLength(1);
  });

  it('ends the run mid-round once the goal is added, moving the level by the cards answered', async () => {
    const { service, repo, jobs, logger, id } = await oneRound({}, 2);
    await service.answer(OWNER, id, 0, { pick: 3, add: false });
    await service.answer(OWNER, id, 1, { pick: null, add: true });
    await service.answer(OWNER, id, 2, { pick: 3, add: false });
    const last = await service.answer(OWNER, id, 3, { pick: 0, add: true });
    expect(last).toMatchObject({ status: 'saved', added_count: 2, cards: [] });
    expect(repo.runs.get(id)?.settledRound).toBe(1);
    // 2 of 4 known: the level stays.
    expect(repo.profiles.get('e1')?.level).toBe(5);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'discovery_ended', run_id: id, reason: 'goal', added_count: 2, saved_count: 0 }));
    // Nothing saved yet: the saves ask for the session when they land.
    expect(stocks(jobs)).toEqual([]);
  });

  it('refuses a new answer once the run ended', async () => {
    const { service, repo } = setup();
    const id = await seedRun(repo, { rounds: 1, answeredInLast: 5, status: 'saved' });
    await expect(service.answer(OWNER, id, 7, { pick: null, add: true })).rejects.toBeInstanceOf(DiscoveryConflict);
  });

  it('answers DiscoveryNotFound for a card that does not exist', async () => {
    const { service, id } = await oneRound();
    await expect(service.answer(OWNER, id, 42, { pick: null, add: true })).rejects.toBeInstanceOf(DiscoveryNotFound);
  });
});

describe('ending a run (phase 74, spec D5, D8)', () => {
  it('ends an asking run and settles its round', async () => {
    const { service, repo, jobs, logger } = setup();
    const id = await seedRun(repo, { rounds: 1, answeredInLast: 6, knownPerRound: 0 });
    expect(await service.end(OWNER, id)).toMatchObject({ status: 'saved', added_count: 6, cards: [] });
    expect(repo.runs.get(id)?.settledRound).toBe(1);
    expect(repo.profiles.get('e1')?.level).toBe(3);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'discovery_ended', run_id: id, reason: 'end', saved_count: 0 }));
    expect(stocks(jobs)).toEqual([]);
  });

  it('asks for the session at once when a word of the run is saved', async () => {
    const { service, repo, jobs } = setup();
    const id = await seedRun(repo, { rounds: 1, answeredInLast: 6, knownPerRound: 5 });
    repo.cards.get(id)![5].savedAt = new Date(NOW);
    await service.end(OWNER, id);
    expect(stocks(jobs)).toEqual([
      { name: STOCK_SESSION, data: { enrollment_id: 'e1', reason: 'discovery' }, options: { singletonKey: 'e1' } },
    ]);
  });

  it('answers an ended run as it is, and refuses a discarded one', async () => {
    const { service, repo, jobs } = setup();
    const id = await seedRun(repo, { rounds: 1, status: 'saved' });
    expect(await service.end(OWNER, id)).toMatchObject({ status: 'saved' });
    expect(jobs.enqueued).toEqual([]);
    await repo.transition(id, ['saved'], 'discarded');
    await expect(service.end(OWNER, id)).rejects.toBeInstanceOf(DiscoveryConflict);
  });
});

describe("an added word's lookup and save (phase 74, spec D5)", () => {
  function looking(senses: string[][] = [['משהו']]) {
    const asked: { actor: string; input: TranslationRequest }[] = [];
    const replies = [...senses];
    const env = setup({
      lookup: async (actor, input) => {
        asked.push({ actor, input });
        return lookupAnswer(replies.length > 1 ? replies.shift()! : replies[0]);
      },
    });
    return { ...env, asked };
  }

  it("looks the word up as typed, for the run's owner, saves the gloss its Hebrew names, and stamps the card", async () => {
    const { service, repo, asked, inserted, jobs, logger } = looking([['משהו אחר', 'משהו']]);
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await service.lookUpWord({ run_id: id, position: 9 });
    expect(asked).toEqual([{ actor: OWNER, input: { text: 'dieci1', from: 'it', to: 'he', enrollment_id: 'e1' } }]);
    expect(inserted).toEqual([[{ glossId: 'g2', variantId: 'v2' }]]);
    expect(repo.cards.get(id)?.[9]).toMatchObject({ lookupStatus: 'ready', chosenGlossId: 'g2', savedAt: expect.any(Date) });
    expect((await service.getRun(OWNER, id)).added).toEqual([{ position: 9, word: 'dieci1', meaning: 'משהו', status: 'saved' }]);
    // A discovery save asks for no delayed stock; the first saved word asks for none at all.
    expect(stocks(jobs)).toEqual([]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'discovered_word_saved', run_id: id, position: 9, hebrew_mismatch: false }));
  });

  it("asks for the session at once when the run's second word is saved, not at the first", async () => {
    const { service, repo, jobs } = looking();
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 7 });
    await service.lookUpWord({ run_id: id, position: 7 });
    expect(stocks(jobs)).toEqual([]);
    await service.lookUpWord({ run_id: id, position: 8 });
    expect(stocks(jobs)).toEqual([
      { name: STOCK_SESSION, data: { enrollment_id: 'e1', reason: 'discovery' }, options: { singletonKey: 'e1' } },
    ]);
    await service.lookUpWord({ run_id: id, position: 9 });
    expect(stocks(jobs)).toHaveLength(1);
  });

  it('saves a word whose lookup lands after the run ended, and asks for the session', async () => {
    const { service, repo, jobs, inserted } = looking();
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9, status: 'saved' });
    await service.lookUpWord({ run_id: id, position: 9 });
    expect(inserted).toHaveLength(1);
    expect(stocks(jobs)).toHaveLength(1);
  });

  it('saves a gloss whose senses did not match the card, and names the saved meaning', async () => {
    const { service, repo, inserted, logger } = looking([['אחר לגמרי']]);
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await service.lookUpWord({ run_id: id, position: 9 });
    expect(inserted).toHaveLength(1);
    expect((await service.getRun(OWNER, id)).added).toEqual([{ position: 9, word: 'dieci1', meaning: 'אחר לגמרי', status: 'saved' }]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'discovered_word_saved', hebrew_mismatch: true }));
  });

  it('saves nothing for a lookup with no gloss, which the run calls failed', async () => {
    const { service, repo, inserted } = looking([[]]);
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await service.lookUpWord({ run_id: id, position: 9 });
    expect(inserted).toEqual([]);
    expect((await service.getRun(OWNER, id)).added).toEqual([{ position: 9, word: 'dieci1', meaning: 'משהו', status: 'failed' }]);
  });

  it('asks the model which sense when no rule can tell, naming the run when its answer is unreadable', async () => {
    const { service, repo } = setup({ lookup: async () => lookupAnswer(['א', 'ב']), match: ['not json'] });
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await expect(service.lookUpWord({ run_id: id, position: 9 })).rejects.toBeInstanceOf(SenseMatchUnreadable);
    expect(repo.cards.get(id)?.[9].lookupStatus).toBe('pending');
  });

  it('makes no lookup for a discarded run, or a card not pending', async () => {
    const { service, repo, asked } = looking();
    const discarded = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await repo.transition(discarded, ['asking'], 'discarded');
    await service.lookUpWord({ run_id: discarded, position: 9 });
    await service.lookUpWord({ run_id: discarded, position: 0 });
    await service.lookUpWord({ run_id: '11111111-1111-1111-1111-111111111111', position: 0 });
    expect(asked).toEqual([]);
    expect(repo.cards.get(discarded)?.[9].lookupStatus).toBe('pending');
  });

  it('writes nothing when the run was discarded during the lookup', async () => {
    const { service, repo, inserted } = setup({
      lookup: async () => {
        await repo.transition([...repo.runs.keys()][0], ['asking'], 'discarded');
        return lookupAnswer(['משהו']);
      },
    });
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await service.lookUpWord({ run_id: id, position: 9 });
    expect(repo.cards.get(id)?.[9].lookupStatus).toBe('pending');
    expect(inserted).toEqual([]);
  });

  it('marks the word failed when its retries are spent', async () => {
    const { service, repo } = setup();
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await service.failWord({ run_id: id, position: 9 });
    expect(repo.cards.get(id)?.[9]).toMatchObject({ lookupStatus: 'failed', ticked: false });
    expect((await service.getRun(OWNER, id)).added).toEqual([{ position: 9, word: 'dieci1', meaning: 'משהו', status: 'failed' }]);
  });
});
