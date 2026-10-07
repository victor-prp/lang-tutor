import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LanguageCode } from '@lang-tutor/core/api';

import { buildPhotoReadingPrompt, parsePhotoReading, type ReadItem } from '../../src/domain/photoReading';
import { buildSenseMatchPrompt, parseSenseMatch, type MatchOption } from '../../src/domain/senseMatching';
import type { LlmClient, VisionClient } from '../../src/services/llm';

/** Phase 26. The real reading prompt and parser, as readPhoto uses them,
 *  minus the database and the queue. */
export async function askPhoto(vision: VisionClient, input: { file: string; language: LanguageCode }): Promise<ReadItem[]> {
  const data = readFileSync(join(__dirname, 'fixtures', 'photos', input.file)).toString('base64');
  const raw = await vision({ ...buildPhotoReadingPrompt(input.language), image: { data, mimeType: 'image/jpeg' } });
  if (raw === '') return [];
  const reading = parsePhotoReading(raw);
  if (!reading) throw new Error(`unreadable reading: ${raw.slice(0, 200)}`);
  return reading.items;
}

/** Phase 26. The real match prompt and parser, as lookUpItem uses them. */
export async function askSenseMatch(
  llm: LlmClient,
  input: { word: string; target: LanguageCode; hebrew: string; options: MatchOption[] },
): Promise<number | 'none'> {
  const raw = await llm(buildSenseMatchPrompt(input));
  const answer = parseSenseMatch(raw, input.options.length);
  if (answer === null) throw new Error(`unreadable match: ${raw.slice(0, 200)}`);
  return answer;
}
