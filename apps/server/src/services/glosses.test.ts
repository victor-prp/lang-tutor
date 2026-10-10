import { describe, expect, it } from '@jest/globals';

import { LlmUnavailable } from '../errors';
import type { GlossRepo, MergeWork } from '../repo/glosses';
import { createFakeLlmClient, createFakeLogger, createFakeTransaction, stub } from '../../tests/support/fakes';
import { createGlossService } from './glosses';

/** A headword with two live glosses in Hebrew and a sense without a definition:
 *  one model call each when the plan asks the model. */
const work = (lemma: string, keys: [string, string]): MergeWork => ({
  lexemeId: `lexeme-${lemma}`,
  lemma,
  partOfSpeech: 'noun',
  languageCode: 'en',
  userLanguageCode: 'he',
  glosses: keys.map((key, i) => ({ id: `${lemma}-${i}`, key, alternatives: [] })),
  senses: [{ senseId: `sense-${lemma}`, senseCode: 'body_part', gloss: keys[0], definition: null }],
});

const FINGER = work('finger', ['אצבע', 'אצבעות']);
const THUMB = work('thumb', ['בוהן', 'בהונות']);
const groups = (...words: string[][]) => JSON.stringify({ groups: words, definitions: [] });

function setup(...replies: (string | Error)[]) {
  const logger = createFakeLogger();
  const gloss = stub<GlossRepo>({ findMergeWork: async () => [FINGER, THUMB], findMergeCandidates: async () => [] });
  const llm = createFakeLlmClient(...replies);
  return { logger, llm, service: createGlossService({ transaction: createFakeTransaction({ gloss }), logger, llm }) };
}

const planned = (merges: { lemma: string; otherKey: string; survivorKey: string; tier: 1 | 2 }[]) =>
  merges.map(({ lemma, otherKey, survivorKey, tier }) => ({ lemma, otherKey, survivorKey, tier }));

describe('planMerges when the model fails one headword (spec D7, the tool)', () => {
  it('skips a headword whose model call fails, plans the rest, and counts it', async () => {
    const { service, llm, logger } = setup(groups(['אצבע', 'אצבעות']), new LlmUnavailable('timed out after 60000ms'));

    const plan = await service.planMerges({ model: true });

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

    const plan = await service.planMerges({ model: true });

    expect(planned(plan.merges)).toEqual([{ lemma: 'thumb', otherKey: 'בהונות', survivorKey: 'בוהן', tier: 2 }]);
    expect(plan.skipped).toBe(1);
    expect(logger.events).toContainEqual({ event: 'gloss_merge_unreadable', lexeme_id: 'lexeme-finger', user_language_code: 'he' });
  });

  // Every failure of the provider is LlmUnavailable (services/llm.ts); anything
  // else is a bug, and a plan built past one would hide it.
  it('lets an error that is not the provider failing stop the plan', async () => {
    const { service } = setup(new Error('a bug in the call'));

    await expect(service.planMerges({ model: true })).rejects.toThrow('a bug in the call');
  });

  // A service composed with no model (the server's, or the tools without
  // --model) must not answer a tier 2 request with tier 1 alone.
  it('refuses tier 2 when no model is composed', async () => {
    const gloss = stub<GlossRepo>({ findMergeWork: async () => [FINGER, THUMB], findMergeCandidates: async () => [] });
    const service = createGlossService({ transaction: createFakeTransaction({ gloss }), logger: createFakeLogger(), llm: null });

    await expect(service.planMerges({ model: true })).rejects.toThrow('tier 2 needs a model');
    expect((await service.planMerges({ model: false })).skipped).toBe(0);
  });

  it('counts nothing skipped when the model is not asked', async () => {
    const { service, llm } = setup(groups());

    const plan = await service.planMerges({ model: false });

    expect(llm.calls).toHaveLength(0);
    expect(plan.skipped).toBe(0);
  });
});
