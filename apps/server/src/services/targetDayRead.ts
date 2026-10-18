import type { Enrollment } from '@lang-tutor/core/api';
import { gradesFor, speakable } from '@lang-tutor/core/domain';

import { liveDimensions } from '../domain/choose';
import type { Devices } from '../domain/session';
import { targetDay } from '../domain/targetDay';
import type { TargetRow } from '../repo/targets';
import { learnerDays } from './learnerDay';
import type { Repos } from './transaction';

/**
 * Phase 57 (spec D5, D6, D9, rulings P4, T3-j). A target's day as its path reads it on
 * `today`: its words (those still saved), each with the day it joined (learnerDays, from
 * when it was added, ruling P4), the day it started and its live skills (speaking skipped
 * for a word that cannot be said, phase 53 R9), its skills, the skills answered right today
 * and whether its path was practised today. `words` are the target's saved words with
 * their forms. Null for a target with no saved word.
 */
export async function readTargetDay(
  repos: Repos,
  enrolled: Enrollment,
  target: TargetRow,
  devices: Devices,
  today: string,
  saved: readonly { glossId: string; form: string }[],
) {
  const rows = await repos.target.listWords(target.id);
  const formOf = new Map(saved.map((gloss) => [gloss.glossId, gloss.form]));
  const words = rows.filter((row) => formOf.has(row.glossId));
  if (words.length === 0) return null;
  const [createdOn, ...addedOn] = await learnerDays(repos, enrolled.user_id, [
    target.createdAt.getTime(),
    ...words.map((word) => word.addedAt.getTime()),
  ]);
  const live = liveDimensions(devices.listening, devices.speaking);
  const liveOf = (glossId: string) => (speakable(formOf.get(glossId)!) ? live : live.filter((dimension) => dimension !== 'spoken_productive'));
  const glossIds = words.map((word) => word.glossId);
  const skills = await repos.targetSkills.findRows([target.id], glossIds);
  const answers = await repos.session.findAnswersOn(enrolled.id, today);
  const rightToday = new Set(
    answers.flatMap((answer) =>
      answer.intro ? [] : gradesFor(answer).flatMap((piece) => (piece.grade > 1 ? [`${answer.glossId}|${piece.dimension}`] : [])),
    ),
  );
  const day = targetDay({
    today,
    createdOn,
    dueOn: target.dueOn,
    words: words.map((word, i) => ({ glossId: word.glossId, addedOn: addedOn[i], startedOn: word.startedOn, live: liveOf(word.glossId) })),
    skills,
    rightToday,
    answeredToday: answers.some((answer) => answer.targetId === target.id),
  });
  return { day, createdOn, glossIds, live, canSay: (glossId: string) => speakable(formOf.get(glossId)!) };
}
