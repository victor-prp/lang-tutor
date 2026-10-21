import { describe, expect, it } from '@jest/globals';
import type { Enrollment, TranslationRequest, TranslationResponse, User } from '@lang-tutor/core/api';

import { DISCOVERY_MARKER } from '../domain/discovery';
import { LOOK_UP_DISCOVERED_WORD } from '../domain/jobs';
import { JUDGE_MARKER } from '../domain/judge';
import {
  AccessDenied,
  DiscoveryConflict,
  DiscoveryNotFound,
  InvalidDiscoveryItem,
  LlmUnavailable,
  SenseMatchUnreadable,
  WrongScript,
} from '../errors';
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

const NOW = Date.parse('2026-10-21T12:00:00Z');
const OWNER = 'u_owner';
const ENROLLMENT = { id: 'e1', user_id: OWNER, source_language: 'he', target_language: 'it' } as Enrollment;

type Reply = string | Error | ((request: LlmJsonRequest) => string | Promise<string>);
const proposal = (word: string, hebrew = `ע${word}`, alternatives: string[] = []) => ({ word, part_of_speech: 'noun', hebrew, alternatives });
const roundOf = (...words: (string | ReturnType<typeof proposal>)[]) =>
  JSON.stringify({ words: words.map((word) => (typeof word === 'string' ? proposal(word) : word)) });
const TEN = ['uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];

function setup(
  opts: {
    profileLevel?: number | null;
    discover?: Reply[];
    judge?: Reply[];
    match?: Reply[];
    saved?: string[];
    repos?: Partial<Repos>;
    lookup?: (actorUserId: string, input: TranslationRequest) => Promise<TranslationResponse>;
  } = {},
) {
  const repo = createFakeDiscoveryRepo();
  if (opts.profileLevel !== null) {
    repo.profiles.set('e1', { enrollmentId: 'e1', selfLevel: 'simple', learningContext: 'school', level: opts.profileLevel ?? 5 });
  }
  const discover = createFakeLlmClient(...(opts.discover ?? [roundOf(...TEN)]));
  const judge = createFakeLlmClient(...(opts.judge ?? ['{"verdict":"right"}']));
  const llm = createFakeLlmClient(...(opts.match ?? ['{"sense":0}']));
  const jobs = createFakeJobRepo();
  const logger = createFakeLogger();
  const transaction = createFakeTransaction({
    discovery: repo,
    jobs,
    enrollment: stub<EnrollmentRepo>({ findById: async (id: string) => (id === 'e1' ? ENROLLMENT : undefined) }),
    grant: stub<GrantRepo>({ findGrantFor: async () => null }),
    user: stub<UserRepo>({ findById: async () => ({ id: OWNER, age: 34 }) as User }),
    vocabulary: stub<VocabularyRepo>({ savedLemmas: async () => opts.saved ?? ['casa'] }),
    ...opts.repos,
  });
  const service = createDiscoveryService({
    transaction,
    discover,
    judge,
    llm,
    lookup:
      opts.lookup ??
      (async (): Promise<TranslationResponse> => {
        throw new Error('no lookup in these tests');
      }),
    now: createFakeClock(NOW),
    logger,
    stockSaveDelaySeconds: 30,
  });
  return { service, repo, discover, judge, llm, jobs, logger };
}

/** A run of `rounds` rounds of ten cards each, the last `answered` cards of the last round
 *  left unanswered when fewer than ten; `known` of each answered round known. */
async function seedRun(
  repo: FakeDiscoveryRepo,
  input: { goal?: number; rounds: number; answeredInLast?: number; knownPerRound?: number; status?: 'asking' | 'listing' | 'saved' },
): Promise<string> {
  const run = (await repo.insertRun({ enrollmentId: 'e1', goal: input.goal ?? 15 }))!;
  for (let round = 1; round <= input.rounds; round += 1) {
    const base = (round - 1) * 10;
    await repo.insertCards(
      run.id,
      TEN.map((word, index) => ({ position: base + index, round, level: 5, word: `${word}${round}`, partOfSpeech: 'noun', hebrew: 'משהו', alternatives: [] })),
    );
    const answered = round === input.rounds ? (input.answeredInLast ?? 10) : 10;
    for (let index = 0; index < answered; index += 1) {
      const known = index < (input.knownPerRound ?? 5);
      await repo.answerCard(run.id, base + index, {
        answer: known ? 'typed' : 'unknown',
        typedText: known ? 'משהו' : null,
        verdict: known ? 'exact' : null,
        known,
        judgedBy: known ? 'rule' : null,
        lookupStatus: known ? null : 'pending',
        answeredAt: new Date(NOW - (1000 - base - index)),
      });
    }
  }
  if (input.rounds > 1) await repo.setSettledRound(run.id, input.rounds - 1);
  if (input.status && input.status !== 'asking') {
    await repo.transition(run.id, ['asking'], 'listing');
    if (input.status === 'saved') await repo.transition(run.id, ['listing'], 'saved');
  }
  return run.id;
}

const userJson = (request: LlmJsonRequest) => JSON.parse(request.user) as Record<string, unknown>;

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

describe('starting a run (phase 69, spec D6, D8)', () => {
  it('refuses a run before the questions', async () => {
    const { service } = setup({ profileLevel: null });
    await expect(service.start(OWNER, 'e1', 15)).rejects.toBeInstanceOf(DiscoveryConflict);
  });

  it('starts a run asking, with no cards yet and no call', async () => {
    const { service, discover } = setup();
    const { run, created } = await service.start(OWNER, 'e1', 10);
    expect(created).toBe(true);
    expect(run).toMatchObject({ goal: 10, status: 'asking', unknown_count: 0, round: 0, cards: [], items: [] });
    expect(discover.calls).toHaveLength(0);
  });

  it('answers the open run instead of a second one', async () => {
    const { service } = setup();
    const first = await service.start(OWNER, 'e1', 10);
    const again = await service.start(OWNER, 'e1', 30);
    expect(again).toMatchObject({ created: false, run: { id: first.run.id, goal: 10 } });
    expect((await service.state(OWNER, 'e1')).run?.id).toBe(first.run.id);
  });
});

describe('a round (phase 69, spec D3, D4, D8)', () => {
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
    expect(next.cards).toEqual(TEN.map((word, position) => ({ position, word })));
    expect(repo.cards.get(run.id)?.every((card) => card.round === 1 && card.level === 5)).toBe(true);
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
    expect(next.cards).toEqual([{ position: 9, word: 'dieci1' }]);
  });

  it('writes nothing when another round landed during the call', async () => {
    const { service, repo } = setup({
      discover: [
        () => {
          const id = [...repo.runs.keys()][0];
          repo.cards.get(id)!.push(newCardRow(id, { position: 10, round: 2, level: 5, word: 'altro', partOfSpeech: 'noun', hebrew: 'אחר', alternatives: [] }));
          return roundOf('primo');
        },
      ],
    });
    const id = await seedRun(repo, { rounds: 1 });
    const next = await service.nextRound(OWNER, id);
    expect(next.cards).toEqual([{ position: 10, word: 'altro' }]);
    expect(repo.cards.get(id)).toHaveLength(11);
    expect(repo.runs.get(id)?.settledRound).toBe(0);
  });

  it('goes to the list after the eighth round, settled, with no call', async () => {
    const { service, repo, discover } = setup();
    const id = await seedRun(repo, { rounds: 8, knownPerRound: 10 });
    const next = await service.nextRound(OWNER, id);
    expect(discover.calls).toHaveLength(0);
    expect(next).toMatchObject({ status: 'listing', cards: [] });
    expect(repo.runs.get(id)?.settledRound).toBe(8);
    expect(repo.profiles.get('e1')?.level).toBe(7);
  });

  it('goes to the list when the model has no word left', async () => {
    const { service, repo } = setup({ discover: [roundOf('casa')], saved: ['casa'] });
    const id = await seedRun(repo, { rounds: 1 });
    expect(await service.nextRound(OWNER, id)).toMatchObject({ status: 'listing', round: 1 });
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

describe('an answer (phase 69, spec D5)', () => {
  async function oneRound(over: Parameters<typeof setup>[0] = {}, goal = 15) {
    const env = setup({
      discover: [roundOf(proposal('gatto', 'חתול', ['חתלתול']), ...TEN.slice(1))],
      ...over,
    });
    const { run } = await env.service.start(OWNER, 'e1', goal);
    await env.service.nextRound(OWNER, run.id);
    return { ...env, id: run.id };
  }

  it('takes "don\'t know" as unknown and starts its lookup', async () => {
    const { service, repo, jobs, id } = await oneRound();
    const result = await service.answer(OWNER, id, 0, { kind: 'unknown' });
    expect(result).toMatchObject({ known: false, meaning: 'חתול', run: { unknown_count: 1 } });
    expect(result.run.cards.map((card) => card.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.run.items).toEqual([
      expect.objectContaining({ position: 0, text: 'gatto', hebrew: 'חתול', status: 'pending', ticked: false }),
    ]);
    expect(repo.cards.get(id)?.[0]).toMatchObject({ answer: 'unknown', known: false, lookupStatus: 'pending', judgedBy: null });
    expect(jobs.enqueued).toEqual([{ name: LOOK_UP_DISCOVERED_WORD, data: { run_id: id, position: 0 } }]);
  });

  it('refuses an answer in the wrong alphabet, writing nothing and calling no judge', async () => {
    const { service, repo, judge, id } = await oneRound();
    await expect(service.answer(OWNER, id, 0, { kind: 'typed', text: 'cat' })).rejects.toBeInstanceOf(WrongScript);
    expect(repo.cards.get(id)?.[0].answer).toBeNull();
    expect(judge.calls).toHaveLength(0);
  });

  it.each([['חתול'], ['חָתוּל'], ['חתלתול']])('knows %s by rule, with no judge', async (text) => {
    const { service, repo, judge, jobs, id } = await oneRound();
    expect(await service.answer(OWNER, id, 0, { kind: 'typed', text })).toMatchObject({ known: true, meaning: 'חתול' });
    expect(repo.cards.get(id)?.[0]).toMatchObject({ answer: 'typed', typedText: text, verdict: 'exact', known: true, judgedBy: 'rule' });
    expect(judge.calls).toHaveLength(0);
    expect(jobs.enqueued).toEqual([]);
  });

  it.each([
    ['right', true, 'exact'],
    ['other_sense', true, 'alternative'],
    ['wrong', false, 'wrong'],
  ])('asks the judge otherwise: %s is known %s', async (said, known, verdict) => {
    const { service, repo, judge, jobs, id } = await oneRound({ judge: [JSON.stringify({ verdict: said })] });
    expect(await service.answer(OWNER, id, 0, { kind: 'typed', text: 'גור' })).toMatchObject({ known });
    expect(repo.cards.get(id)?.[0]).toMatchObject({ verdict, known, judgedBy: 'model' });
    expect(judge.calls[0].system).toContain(JUDGE_MARKER);
    expect(judge.calls[0].record).toEqual({ kind: 'judge', enrollmentId: 'e1', userId: OWNER });
    expect(userJson(judge.calls[0])).toMatchObject({ word: 'gatto', saved_meaning: 'חתול', example: null, answer: 'גור' });
    expect(jobs.enqueued).toHaveLength(known ? 0 : 1);
  });

  it('counts an answer unknown when the judge fails', async () => {
    const { service, repo, jobs, logger, id } = await oneRound({ judge: [new LlmUnavailable('timed out')] });
    expect(await service.answer(OWNER, id, 0, { kind: 'typed', text: 'גור' })).toMatchObject({ known: false });
    expect(repo.cards.get(id)?.[0]).toMatchObject({ verdict: null, known: false, judgedBy: 'unavailable', lookupStatus: 'pending' });
    expect(jobs.enqueued).toHaveLength(1);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'discovery_judge_failed', run_id: id, position: 0 }));
  });

  it('answers a card answered before with its first verdict, starting no second lookup', async () => {
    const { service, jobs, judge, id } = await oneRound();
    await service.answer(OWNER, id, 0, { kind: 'unknown' });
    expect(await service.answer(OWNER, id, 0, { kind: 'typed', text: 'חתול' })).toMatchObject({ known: false, meaning: 'חתול' });
    expect(jobs.enqueued).toHaveLength(1);
    expect(judge.calls).toHaveLength(0);
  });

  it('goes to the list mid-round once the goal is reached, moving the level by the cards answered', async () => {
    const { service, repo, id } = await oneRound({}, 4);
    for (const position of [0, 1, 2]) await service.answer(OWNER, id, position, { kind: 'unknown' });
    const last = await service.answer(OWNER, id, 3, { kind: 'unknown' });
    expect(last.run).toMatchObject({ status: 'listing', unknown_count: 4, cards: [] });
    expect(repo.runs.get(id)?.settledRound).toBe(1);
    expect(repo.profiles.get('e1')?.level).toBe(3);
  });

  it("goes to the list on a round's last card, settled once, and offers no next round", async () => {
    const { service, repo, discover } = setup({ discover: [roundOf(...TEN)] });
    const id = await seedRun(repo, { rounds: 1, answeredInLast: 9, knownPerRound: 0, goal: 10 });
    const last = await service.answer(OWNER, id, 9, { kind: 'unknown' });
    expect(last.run).toMatchObject({ status: 'listing', unknown_count: 10 });
    expect(repo.runs.get(id)?.settledRound).toBe(1);
    expect(repo.profiles.get('e1')?.level).toBe(3);
    expect(await service.nextRound(OWNER, id)).toMatchObject({ status: 'listing' });
    expect(repo.profiles.get('e1')?.level).toBe(3);
    expect(discover.calls).toHaveLength(0);
  });

  it('refuses a new answer once the run lists', async () => {
    const { service, repo } = setup();
    const id = await seedRun(repo, { rounds: 1, answeredInLast: 5, status: 'listing' });
    await expect(service.answer(OWNER, id, 7, { kind: 'unknown' })).rejects.toBeInstanceOf(DiscoveryConflict);
  });

  it('answers DiscoveryNotFound for a card that does not exist', async () => {
    const { service, id } = await oneRound();
    await expect(service.answer(OWNER, id, 42, { kind: 'unknown' })).rejects.toBeInstanceOf(DiscoveryNotFound);
  });
});

describe('ending a run early (phase 69, spec D8)', () => {
  it('moves an asking run to its list and settles its round', async () => {
    const { service, repo } = setup();
    const id = await seedRun(repo, { rounds: 1, answeredInLast: 6, knownPerRound: 0 });
    expect(await service.end(OWNER, id)).toMatchObject({ status: 'listing', unknown_count: 6, cards: [] });
    expect(repo.runs.get(id)?.settledRound).toBe(1);
    expect(repo.profiles.get('e1')?.level).toBe(3);
  });

  it('answers a listing run as it is, and refuses a saved one', async () => {
    const { service, repo } = setup();
    const listing = await seedRun(repo, { rounds: 1, status: 'listing' });
    expect(await service.end(OWNER, listing)).toMatchObject({ status: 'listing' });
    await repo.transition(listing, ['listing'], 'saved');
    await expect(service.end(OWNER, listing)).rejects.toBeInstanceOf(DiscoveryConflict);
  });
});

const option = (n: number) => ({ gloss_id: `g${n}`, variant_id: `v${n}`, translation: `t${n}` });
const looked = (options = [option(1), option(2)]) => ({
  correctedForm: null,
  options,
  chosenGlossId: options[0]?.gloss_id ?? null,
  ticked: options.length > 0,
  hebrewMismatch: false,
  reason: options.length > 0 ? null : ('no_meaning' as const),
});

/** A listing run whose first `unknown` cards were not known, each looked up unless `pending`. */
async function listingRun(repo: FakeDiscoveryRepo, unknown: number, pending: number[] = []) {
  const id = await seedRun(repo, { rounds: 1, knownPerRound: 10 - unknown });
  // seedRun marks the first cards known: the unknown ones are the last `unknown`.
  for (const card of repo.cards.get(id)!) {
    if (card.known === false && !pending.includes(card.position)) await repo.writeLookup(id, card.position, looked());
  }
  await repo.transition(id, ['asking'], 'listing');
  return id;
}

describe('the list (phase 69, spec D8)', () => {
  it('changes a row as a photo row is changed', async () => {
    const { service, repo } = setup();
    const id = await listingRun(repo, 3);
    expect(await service.updateItem(OWNER, id, 9, { ticked: false })).toMatchObject({ position: 9, ticked: false, chosen_gloss_id: 'g1' });
    expect(await service.updateItem(OWNER, id, 9, { gloss_id: 'g2' })).toMatchObject({ chosen_gloss_id: 'g2' });
    await expect(service.updateItem(OWNER, id, 9, { gloss_id: 'g9' })).rejects.toBeInstanceOf(InvalidDiscoveryItem);
  });

  it('refuses a change to a row still looked up, a card that is no row, and a run not listing', async () => {
    const { service, repo } = setup();
    const id = await listingRun(repo, 3, [8]);
    await expect(service.updateItem(OWNER, id, 8, { ticked: false })).rejects.toBeInstanceOf(DiscoveryConflict);
    await expect(service.updateItem(OWNER, id, 0, { ticked: false })).rejects.toBeInstanceOf(DiscoveryNotFound);
    const other = setup();
    const askingId = await seedRun(other.repo, { rounds: 1, knownPerRound: 0 });
    await expect(other.service.updateItem(OWNER, askingId, 0, { ticked: false })).rejects.toBeInstanceOf(DiscoveryConflict);
  });
});

describe('saving the list (phase 69, spec D8)', () => {
  function saving() {
    const inserted: { glossId: string; variantId: string }[][] = [];
    const env = setup({
      repos: {
        gloss: stub<GlossRepo>({
          resolveGlosses: async (ids: string[]) => new Map(ids.map((glossId) => [glossId, { id: glossId, userLanguageCode: 'he' }])),
        } as Partial<GlossRepo>),
        vocabulary: stub<VocabularyRepo>({
          savedLemmas: async () => [],
          findSaveable: async (input) => input.entries.map((entry) => ({ ...entry, lexemeId: `l${entry.glossId}`, lemma: entry.glossId })),
          insertEntries: async (input) => {
            inserted.push(input.entries.map((entry) => ({ glossId: entry.glossId, variantId: entry.variantId })));
          },
        }),
        dict: stub<DictRepo>({ claimLemmaRenders: async () => [] }),
      },
    });
    return { ...env, inserted };
  }

  it("saves the ticked rows' glosses to My words in one go, and the run is saved", async () => {
    const { service, repo, inserted, jobs, logger } = saving();
    const id = await listingRun(repo, 3);
    for (const card of repo.cards.get(id)!.filter((c) => c.known === false)) card.chosenGlossId = `g${card.position}`;
    for (const card of repo.cards.get(id)!.filter((c) => c.known === false)) card.options = [{ ...option(1), gloss_id: `g${card.position}` }];
    await service.updateItem(OWNER, id, 8, { ticked: false });

    expect(await service.save(OWNER, id)).toEqual({ saved_gloss_ids: ['g7', 'g9'] });
    expect(inserted).toEqual([[{ glossId: 'g7', variantId: 'v1' }, { glossId: 'g9', variantId: 'v1' }]]);
    expect(repo.runs.get(id)?.status).toBe('saved');
    expect(jobs.enqueued).toContainEqual(expect.objectContaining({ name: 'stock-session' }));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'discovery_saved', run_id: id, saved_count: 2, unticked_count: 1 }));

    // A repeated save answers the same ids and writes nothing.
    expect(await service.save(OWNER, id)).toEqual({ saved_gloss_ids: ['g7', 'g9'] });
    expect(inserted).toHaveLength(1);
  });

  it('refuses a save while a row is looked up, and one of a run still asking', async () => {
    const { service, repo, inserted } = saving();
    const id = await listingRun(repo, 3, [9]);
    await expect(service.save(OWNER, id)).rejects.toBeInstanceOf(DiscoveryConflict);
    expect(repo.runs.get(id)?.status).toBe('listing');
    expect(inserted).toEqual([]);
    const other = saving();
    const asking = await seedRun(other.repo, { rounds: 1, knownPerRound: 0 });
    await expect(other.service.save(OWNER, asking)).rejects.toBeInstanceOf(DiscoveryConflict);
    expect(other.inserted).toEqual([]);
  });

  it('saves nothing from a list with no row ticked, and the run is saved', async () => {
    const { service, repo, inserted } = saving();
    const id = await listingRun(repo, 2);
    for (const position of [8, 9]) await service.updateItem(OWNER, id, position, { ticked: false });
    expect(await service.save(OWNER, id)).toEqual({ saved_gloss_ids: [] });
    expect(inserted).toEqual([]);
    expect(repo.runs.get(id)?.status).toBe('saved');
  });
});

describe('discarding a run (phase 69, spec D8)', () => {
  it('discards an asking or listing run, keeps its answers, and repeats quietly', async () => {
    const { service, repo } = setup();
    const id = await seedRun(repo, { rounds: 1, answeredInLast: 4 });
    await service.discard(OWNER, id);
    expect(repo.runs.get(id)?.status).toBe('discarded');
    expect(repo.cards.get(id)?.filter((card) => card.answer !== null)).toHaveLength(4);
    await service.discard(OWNER, id);
    expect(repo.runs.get(id)?.status).toBe('discarded');
  });

  it('refuses to discard a saved run', async () => {
    const { service, repo } = setup();
    const id = await seedRun(repo, { rounds: 1, status: 'saved' });
    await expect(service.discard(OWNER, id)).rejects.toBeInstanceOf(DiscoveryConflict);
  });
});

describe("a word's lookup (phase 69, spec D7)", () => {
  const lookupAnswer = (translations: string[]): TranslationResponse =>
    ({
      kind: 'word',
      senses: translations.map((translation, index) => ({ ...option(index + 1), translation, gloss_id: `g${index + 1}`, variant_id: `v${index + 1}` })),
    }) as unknown as TranslationResponse;

  it("looks the word up as typed, for the list's owner, and picks the gloss its Hebrew names", async () => {
    const asked: { actor: string; input: TranslationRequest }[] = [];
    const { service, repo, llm } = setup({
      lookup: async (actor, input) => {
        asked.push({ actor, input });
        return lookupAnswer(['משהו אחר', 'משהו']);
      },
    });
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await service.lookUpWord({ run_id: id, position: 9 });
    expect(asked).toEqual([{ actor: OWNER, input: { text: 'dieci1', from: 'it', to: 'he', enrollment_id: 'e1' } }]);
    expect(repo.cards.get(id)?.[9]).toMatchObject({ lookupStatus: 'ready', chosenGlossId: 'g2', suggestedGlossId: 'g2', ticked: true });
    expect(llm.calls).toHaveLength(0);
  });

  it('asks the model which sense when no rule can tell, naming the run when its answer is unreadable', async () => {
    const { service, repo } = setup({ lookup: async () => lookupAnswer(['א', 'ב']), match: ['not json'] });
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await expect(service.lookUpWord({ run_id: id, position: 9 })).rejects.toBeInstanceOf(SenseMatchUnreadable);
    expect(repo.cards.get(id)?.[9].lookupStatus).toBe('pending');
  });

  it('makes no lookup for a discarded or saved run, or a card not pending', async () => {
    let lookups = 0;
    const { service, repo } = setup({
      lookup: async () => {
        lookups += 1;
        return lookupAnswer(['משהו']);
      },
    });
    const discarded = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await repo.transition(discarded, ['asking'], 'discarded');
    await service.lookUpWord({ run_id: discarded, position: 9 });
    await service.lookUpWord({ run_id: discarded, position: 0 });
    await service.lookUpWord({ run_id: '11111111-1111-1111-1111-111111111111', position: 0 });
    expect(lookups).toBe(0);
    expect(repo.cards.get(discarded)?.[9].lookupStatus).toBe('pending');
  });

  it('writes nothing when the run was discarded during the lookup', async () => {
    const { service, repo } = setup({
      lookup: async () => {
        await repo.transition([...repo.runs.keys()][0], ['asking'], 'discarded');
        return lookupAnswer(['משהו']);
      },
    });
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await service.lookUpWord({ run_id: id, position: 9 });
    expect(repo.cards.get(id)?.[9].lookupStatus).toBe('pending');
  });

  it('marks the row failed when its retries are spent', async () => {
    const { service, repo } = setup();
    const id = await seedRun(repo, { rounds: 1, knownPerRound: 9 });
    await service.failWord({ run_id: id, position: 9 });
    expect(repo.cards.get(id)?.[9]).toMatchObject({ lookupStatus: 'failed', ticked: false });
  });
});
