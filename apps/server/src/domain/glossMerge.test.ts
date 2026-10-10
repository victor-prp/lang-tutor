import { describe, expect, it } from '@jest/globals';

import { buildGlossMergePrompt, GLOSS_MERGE_MARKER, mutualPairs, parseGlossMerge } from './glossMerge';

describe('the model tier of dict:glosses:merge (spec D7)', () => {
  const prompt = buildGlossMergePrompt({
    lemma: 'finger',
    partOfSpeech: 'noun',
    from: 'en',
    to: 'he',
    glosses: [{ key: 'אצבע', alternatives: [] }, { key: 'אצבעות', alternatives: [] }],
    senses: [{ senseCode: 'body_part', gloss: 'אצבעות', definition: null }],
  });

  it('asks which target words are forms of one word, and for missing definitions', () => {
    expect(prompt.system).toContain(GLOSS_MERGE_MARKER);
    expect(JSON.parse(prompt.user)).toEqual({
      headword: 'finger',
      part_of_speech: 'noun',
      words: ['אצבע', 'אצבעות'],
      senses_without_definition: [{ sense_code: 'body_part', gloss: 'אצבעות' }],
    });
  });

  it('reads groups with the citation form first, and definitions', () => {
    expect(parseGlossMerge('{"groups":[["אצבע","אצבעות"]],"definitions":[{"sense_code":"body_part","definition":"one of the five parts at the end of the hand"}]}')).toEqual({
      groups: [['אצבע', 'אצבעות']],
      definitions: [{ senseCode: 'body_part', definition: 'one of the five parts at the end of the hand' }],
    });
    expect(parseGlossMerge('not json')).toBeNull();
  });

  it('lists two glosses that name each other among their alternatives, which it never merges', () => {
    expect(
      mutualPairs([
        { id: 'g1', key: 'מדהים', alternatives: ['נהדר'] },
        { id: 'g2', key: 'נהדר', alternatives: ['מדהים'] },
        { id: 'g3', key: 'מצוין', alternatives: ['נהדר'] },
      ]),
    ).toEqual([['g1', 'g2']]);
  });
});
