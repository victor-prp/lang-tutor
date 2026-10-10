import { LlmGlossMergeSchema } from '@lang-tutor/core/api/schemas';
import { normaliseGloss } from '@lang-tutor/core/domain';

import { LANGUAGES, type LanguageCode } from './languages';
import { dropNulls, unfence } from './translation';

/**
 * Phase 31 (spec D7). The model-judged tier of `dict:glosses:merge`: which of a
 * headword's target words are forms of one word (gender, number, spelling), so
 * their glosses can be merged, and definitions for senses written without one.
 * Run by hand only: a merge cannot be undone, so the tool prints its plan first.
 */
export const GLOSS_MERGE_MARKER = 'forms of one word';

export type GlossMergePrompt = { system: string; user: string; schema: typeof LlmGlossMergeSchema };

export function buildGlossMergePrompt(input: {
  lemma: string;
  partOfSpeech: string;
  from: LanguageCode;
  to: LanguageCode;
  glosses: { key: string; alternatives: string[] }[];
  senses: { senseCode: string; gloss: string; definition: string | null }[];
}): GlossMergePrompt {
  const from = LANGUAGES[input.from].name;
  const to = LANGUAGES[input.to].name;
  const system = [
    `A ${from} headword has several ${to} target words recorded for its senses. Say which of them are ${GLOSS_MERGE_MARKER}: the same word in another gender, number or spelling.`,
    'Return JSON only, matching the supplied schema.',
    'In "groups", list each set of two or more such words, its dictionary citation form first. Leave out a word that is a different word, even one that means the same: synonyms are never forms of one word.',
    `In "definitions", define each sense listed without a definition in one short phrase in ${from}, by its sense_code.`,
  ].join('\n');
  const user = JSON.stringify({
    headword: input.lemma,
    part_of_speech: input.partOfSpeech,
    words: input.glosses.map((gloss) => gloss.key),
    senses_without_definition: input.senses
      .filter((sense) => sense.definition === null)
      .map((sense) => ({ sense_code: sense.senseCode, gloss: sense.gloss })),
  });
  return { system, user, schema: LlmGlossMergeSchema };
}

/** Null when unreadable. */
export function parseGlossMerge(raw: string): { groups: string[][]; definitions: { senseCode: string; definition: string }[] } | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const parsed = LlmGlossMergeSchema.safeParse(dropNulls(json));
  if (!parsed.success) return null;
  return {
    groups: parsed.data.groups.filter((group) => group.length >= 2),
    definitions: parsed.data.definitions.map((d) => ({ senseCode: d.sense_code, definition: d.definition.trim() })),
  };
}

/** Pairs of glosses that each name the other's key among their alternatives:
 *  listed to the operator as suggestions and never merged, because two glosses
 *  of one headword always hold different senses (spec D7, the Out list). */
export function mutualPairs(glosses: { id: string; key: string; alternatives: string[] }[]): [string, string][] {
  const names = (gloss: { alternatives: string[] }, key: string) =>
    gloss.alternatives.some((alternative) => normaliseGloss(alternative) === normaliseGloss(key));
  const pairs: [string, string][] = [];
  glosses.forEach((a, i) =>
    glosses.slice(i + 1).forEach((b) => {
      if (names(a, b.key) && names(b, a.key)) pairs.push([a.id, b.id]);
    }),
  );
  return pairs;
}
