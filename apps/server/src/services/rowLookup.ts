import type { Enrollment, TranslationRequest, TranslationResponse } from '@lang-tutor/core/api';

import type { LanguageCode } from '../domain/languages';
import { optionsFrom, reasonFor } from '../domain/photoImports';
import { buildSenseMatchPrompt, choiceFromModel, firstChoice, parseSenseMatch, type MatchedBy } from '../domain/senseMatching';
import type { ItemResult } from '../repo/photoImports';
import type { LlmClient, ModelCallRecord } from './llm';

/**
 * Phase 26 (spec D7), shared since phase 69. A row of a word list looked up for review: the
 * lookup exactly as if the word were typed, its saveable glosses, and the one the Hebrew
 * beside it names, asking the model when no rule can tell. A photo row's job and a Words for
 * me card's job both call it; each writes the result to its own row.
 *
 * `onUnreadable` is the error a match answer that cannot be read throws, so the job's queue
 * retries it with the row's own name.
 */
export async function lookUpRow(
  deps: {
    lookup: (actorUserId: string, input: TranslationRequest) => Promise<TranslationResponse>;
    llm: LlmClient;
  },
  input: {
    enrolled: Enrollment;
    text: string;
    hebrew: string | null;
    record: ModelCallRecord;
    onUnreadable: () => Error;
  },
): Promise<{ result: ItemResult; matchedBy: MatchedBy | null }> {
  const { enrolled } = input;
  const target = enrolled.target_language as LanguageCode;
  // The job has no actor of its own. It looks up for the list's owner, the only
  // one who could have made the list.
  const response = await deps.lookup(enrolled.user_id, {
    text: input.text,
    from: target,
    to: enrolled.source_language as LanguageCode,
    enrollment_id: enrolled.id,
  });
  const correctedForm = response.correction?.corrected_form ?? null;
  const options = optionsFrom(response.senses);
  if (options.length === 0) {
    return {
      result: { correctedForm, options, chosenGlossId: null, ticked: false, hebrewMismatch: false, reason: reasonFor(response) },
      matchedBy: null,
    };
  }
  let choice = firstChoice(input.hebrew, options);
  if (choice === 'ask_model') {
    const raw = await deps.llm({
      ...buildSenseMatchPrompt({ word: correctedForm ?? input.text, target, hebrew: input.hebrew ?? '', options }),
      record: input.record,
    });
    const answer = parseSenseMatch(raw, options.length);
    if (answer === null) throw input.onUnreadable();
    choice = choiceFromModel(answer);
  }
  return {
    result: {
      correctedForm,
      options,
      chosenGlossId: options[choice.index].gloss_id,
      ticked: true,
      hebrewMismatch: choice.mismatch,
      reason: null,
    },
    matchedBy: choice.matchedBy,
  };
}
