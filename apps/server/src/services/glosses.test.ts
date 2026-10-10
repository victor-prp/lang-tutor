import { describe, expect, it } from '@jest/globals';

import { LlmUnavailable } from '../errors';
import type { GlossRepo, MergeWork } from '../repo/glosses';
import type { LlmJsonRequest } from './llm';
import { createFakeLlmClient, createFakeLogger, createFakeTransaction, stub } from '../../tests/support/fakes';
import { createGlossService, type MergeProgress } from './glosses';

/** A headword with its live glosses in Hebrew and one sense, without a
 *  definition unless one is given. */
const work = (lemma: string, keys: string[], definition: string | null = null): MergeWork => ({
  lexemeId: `lexeme-${lemma}`,
  lemma,
  partOfSpeech: 'noun',
  languageCode: 'en',
  userLanguageCode: 'he',
  glosses: keys.map((key, i) => ({ id: `${lemma}-${i}`, key, alternatives: [] })),
  senses: [{ senseId: `sense-${lemma}`, senseCode: 'body_part', gloss: keys[0], definition }],
});

const FINGER = work('finger', ['אצבע', 'אצבעות']);
const THUMB = work('thumb', ['בוהן', 'בהונות']);
/** One live gloss and a sense with no definition: tier 2 asks about it only
 *  with --definitions. */
const PALM = work('palm', ['כף יד']);
/** One live gloss, every sense defined: nothing for tier 2 to ask. */
const WRIST = work('wrist', ['שורש כף היד'], 'the joint between the hand and the arm');

const groups = (...words: string[][]) => JSON.stringify({ groups: words, definitions: [] });
const IGNORE = (): void => {};
const headwordOf = (request: LlmJsonRequest) => (JSON.parse(request.user) as { headword: string }).headword;

/** The planner over these headwords, the model answering in order, the last
 *  answer repeating. */
function over(found: MergeWork[], ...replies: (string | Error)[]) {
  const logger = createFakeLogger();
  const gloss = stub<GlossRepo>({ findMergeWork: async () => found, findMergeCandidates: async () => [] });
  const llm = createFakeLlmClient(...replies);
  return { logger, llm, service: createGlossService({ transaction: createFakeTransaction({ gloss }), logger, llm }) };
}

const setup = (...replies: (string | Error)[]) => over([FINGER, THUMB], ...replies);

const planned = (merges: { lemma: string; otherKey: string; survivorKey: string; tier: 1 | 2 }[]) =>
  merges.map(({ lemma, otherKey, survivorKey, tier }) => ({ lemma, otherKey, survivorKey, tier }));

describe('planMerges when the model fails one headword (spec D7, the tool)', () => {
  it('skips a headword whose model call fails, plans the rest, and counts it', async () => {
    const { service, llm, logger } = setup(groups(['אצבע', 'אצבעות']), new LlmUnavailable('timed out after 60000ms'));

    const plan = await service.planMerges({ model: true, definitions: false, onProgress: IGNORE });

    expect(llm.calls).toHaveLength(2);
    expect(planned(plan.merges)).toEqual([{ lemma: 'finger', otherKey: 'אצבעות', survivorKey: 'אצבע', tier: 2 }]);
    expect(plan.skipped).toBe(1);
    expect(logger.events).toContainEqual({
      event: 'gloss_merge_unavailable',
      lexeme_id: 'lexeme-thumb',
      user_language_code: 'he',
      reason: 'language model unavailable: timed out after 60000ms',
    });
  });

  it('skips a headword whose answer is unreadable the same way', async () => {
    const { service, logger } = setup('not json', groups(['בוהן', 'בהונות']));

    const plan = await service.planMerges({ model: true, definitions: false, onProgress: IGNORE });

    expect(planned(plan.merges)).toEqual([{ lemma: 'thumb', otherKey: 'בהונות', survivorKey: 'בוהן', tier: 2 }]);
    expect(plan.skipped).toBe(1);
    expect(logger.events).toContainEqual({ event: 'gloss_merge_unreadable', lexeme_id: 'lexeme-finger', user_language_code: 'he' });
  });

  // Every failure of the provider is LlmUnavailable (services/llm.ts); anything
  // else is a bug, and a plan built past one would hide it.
  it('lets an error that is not the provider failing stop the plan', async () => {
    const { service } = setup(new Error('a bug in the call'));

    await expect(service.planMerges({ model: true, definitions: false, onProgress: IGNORE })).rejects.toThrow('a bug in the call');
  });

  // A service composed with no model (the server's, or the tools without
  // --model) must not answer a tier 2 request with tier 1 alone.
  it('refuses tier 2 when no model is composed', async () => {
    const gloss = stub<GlossRepo>({ findMergeWork: async () => [FINGER, THUMB], findMergeCandidates: async () => [] });
    const service = createGlossService({ transaction: createFakeTransaction({ gloss }), logger: createFakeLogger(), llm: null });

    await expect(service.planMerges({ model: true, definitions: false, onProgress: IGNORE })).rejects.toThrow('tier 2 needs a model');
    expect((await service.planMerges({ model: false, definitions: false, onProgress: IGNORE })).skipped).toBe(0);
  });

  it('counts nothing skipped when the model is not asked', async () => {
    const { service, llm } = setup(groups());

    const plan = await service.planMerges({ model: false, definitions: false, onProgress: IGNORE });

    expect(llm.calls).toHaveLength(0);
    expect(plan.skipped).toBe(0);
  });
});

// After the deploy nearly every sense lacks a definition, so a tier 2 that
// asked about every such headword would be a model call per headword in the
// dictionary. It asks, as the spec's selection says, about the headwords with
// more than one live gloss, and fills their definitions on the way; a
// definitions-only run is asked for by name.
describe('planMerges, the headwords tier 2 asks (spec D7, the tool)', () => {
  const defined = JSON.stringify({ groups: [], definitions: [{ sense_code: 'body_part', definition: 'a part of the hand' }] });

  it('asks only about the headwords with more than one live gloss, and fills their definitions', async () => {
    const { service, llm } = over([FINGER, PALM, THUMB, WRIST], defined);

    const plan = await service.planMerges({ model: true, definitions: false, onProgress: IGNORE });

    expect(llm.calls.map(headwordOf)).toEqual(['finger', 'thumb']);
    expect(plan.definitions).toEqual([
      { senseId: 'sense-finger', definition: 'a part of the hand' },
      { senseId: 'sense-thumb', definition: 'a part of the hand' },
    ]);
  });

  it('with --definitions, also asks about a headword one of whose senses has no definition', async () => {
    const { service, llm } = over([FINGER, PALM, THUMB, WRIST], defined);

    const plan = await service.planMerges({ model: true, definitions: true, onProgress: IGNORE });

    expect(llm.calls.map(headwordOf)).toEqual(['finger', 'palm', 'thumb']);
    expect(plan.definitions.map((row) => row.senseId)).toEqual(['sense-finger', 'sense-palm', 'sense-thumb']);
  });

  // --definitions extends tier 2; without the model it would print a plan
  // with no definitions to fill, which reads as nothing missing.
  it('refuses --definitions without the model', async () => {
    const { service, llm } = over([FINGER, PALM], defined);

    await expect(service.planMerges({ model: false, definitions: true, onProgress: IGNORE })).rejects.toThrow(
      '--definitions extends tier 2',
    );
    expect(llm.calls).toHaveLength(0);
  });
});

// A by-hand run over a whole dictionary must say what it is about to cost and
// show that it is moving: the CLI prints these lines (ADR 0001 R7 keeps the
// service off the console).
describe('planMerges progress (spec D7, the tool)', () => {
  it('reports how many headwords tier 2 will ask before the first call, then one line per headword as it goes', async () => {
    const { service, llm } = over([FINGER, PALM, THUMB], groups(['אצבע', 'אצבעות']), new LlmUnavailable('timed out after 60000ms'));
    const seen: { progress: MergeProgress; calls: number }[] = [];

    await service.planMerges({
      model: true,
      definitions: false,
      onProgress: (progress) => seen.push({ progress, calls: llm.calls.length }),
    });

    expect(seen).toEqual([
      { progress: { kind: 'asking', headwords: 2 }, calls: 0 },
      {
        progress: { kind: 'asked', done: 1, of: 2, lemma: 'finger', partOfSpeech: 'noun', userLanguageCode: 'he', merges: 1, definitions: 0, skipped: false },
        calls: 1,
      },
      {
        progress: { kind: 'asked', done: 2, of: 2, lemma: 'thumb', partOfSpeech: 'noun', userLanguageCode: 'he', merges: 0, definitions: 0, skipped: true },
        calls: 2,
      },
    ]);
  });

  it('counts the headwords --definitions adds', async () => {
    const { service } = over([FINGER, PALM, THUMB, WRIST], groups());
    const seen: MergeProgress[] = [];

    await service.planMerges({ model: true, definitions: true, onProgress: (progress) => seen.push(progress) });

    expect(seen[0]).toEqual({ kind: 'asking', headwords: 3 });
    expect(seen.slice(1).map((progress) => (progress.kind === 'asked' ? progress.lemma : null))).toEqual(['finger', 'palm', 'thumb']);
  });

  it('reports nothing when the model is not asked', async () => {
    const { service } = over([FINGER, PALM, THUMB], groups());
    const seen: MergeProgress[] = [];

    await service.planMerges({ model: false, definitions: false, onProgress: (progress) => seen.push(progress) });

    expect(seen).toEqual([]);
  });
});
