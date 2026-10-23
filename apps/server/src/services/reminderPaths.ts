import type { Enrollment, MyWordsToday, TargetList } from '@lang-tutor/core/api';

import type { ReminderPath } from '../domain/reminders';

/**
 * Phase 75 (spec D1). The reads a reminder's day is made of, each another service's use case
 * handed in by the composition root, as phase 26 hands the photo import its lookup (ADR 0001 R8):
 * this module imports their types only. `targets` is the read home's target cards are drawn from,
 * so a reminder's numbers are the card's; `myWordsDay` is home's main-path read without its writes.
 * Each is one read transaction of its own, and acts as the learner over their own enrollment.
 */
export type PathReads = {
  enrollments: (userId: string) => Promise<Enrollment[]>;
  targets: (actorUserId: string, enrollmentId: string) => Promise<TargetList>;
  myWordsDay: (actorUserId: string, enrollmentId: string) => Promise<{ today: MyWordsToday; waiting: number; saved: number }>;
};

/**
 * A learner's paths for a reminder: for each enrollment they own, in their order, its active
 * targets, then its My words. A read that fails fails the whole list: a reminder chosen over part
 * of the day could name the wrong path.
 */
export function createReminderPaths(reads: PathReads): (userId: string) => Promise<ReminderPath[]> {
  return async (userId) => {
    const paths: ReminderPath[] = [];
    for (const enrollment of await reads.enrollments(userId)) {
      const language = enrollment.target_language;
      const { targets } = await reads.targets(userId, enrollment.id);
      for (const target of targets) {
        paths.push({
          kind: target.kind,
          enrollmentId: enrollment.id,
          language,
          targetId: target.id,
          daysLeft: target.days_left,
          state: target.today.state,
          wordCount: target.word_count,
          readyCount: target.ready_count,
          readinessPct: target.readiness_pct,
          sessionsOffer: target.today.sessions_offer,
          sessionsDone: target.today.sessions_done,
          minutes: target.today.minutes,
        });
      }
      const day = await reads.myWordsDay(userId, enrollment.id);
      paths.push({
        kind: 'my_words',
        enrollmentId: enrollment.id,
        language,
        goal: day.today.goal,
        sessionsDone: day.today.sessions_done,
        waiting: day.waiting,
        saved: day.saved,
      });
    }
    return paths;
  };
}
