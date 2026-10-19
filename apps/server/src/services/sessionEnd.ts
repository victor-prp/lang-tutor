import { applySession } from '../domain/memoryUpdate';
import { evaluateSession } from '../domain/progress';
import { readinessSessionWrite } from '../domain/readinessWrite';
import { targetSessionWrite } from '../domain/targetSkills';
import type { SessionEvidence } from '../repo/progress';
import { learnerDay } from './learnerDay';
import type { Repos } from './transaction';

/**
 * Phase 20. Runs the progress rule over an ended session's answers, inside the
 * transaction that ended it. The status change and these writes are dependent
 * (ADR 0001 R8, spec §3): an ended session without its progress, or progress
 * for a session that did not end, would each be wrong.
 *
 * A gloss with no rows is not saved, so it is skipped: that is the whole of
 * "only answers given while saved count". A session with no answers has no
 * evidence and writes nothing.
 *
 * Phase 31 (spec D14). The practised glosses' lexemes are share-locked before
 * anything is read, so a merge of one of them lands wholly before the evidence
 * is read or wholly after the progress is written: never between.
 *
 * Phase 57 (spec D4). The target skills are written here too, in the same
 * transaction: an ended session with part of its write would be as wrong. Each path has a
 * started session of its own (ADR 0014), so two of an enrollment's sessions can end at once:
 * the enrollment's progress lock is taken first (rulings T4-i, T4-k), so one end reads what
 * the other wrote, and a word taken out of a target waits for it.
 *
 * Shared by every session end (services/sessions.ts) and by a target's end, which skips its
 * path's started session (final review I1, skipOpenSession). db/progressRecompute.ts repeats
 * these calls; its integration test keeps the two in step.
 */
export async function recordProgress(repos: Repos, sessionId: string, enrollmentId: string): Promise<void> {
  await repos.progress.lockEnrollment(enrollmentId);
  await repos.progress.lockSessionGlosses(sessionId);
  const evidence = await repos.progress.findSessionEvidence(sessionId);
  if (!evidence) return;
  // Phase 65 (spec R1): readiness starts from the memory as it stood before this session.
  await recordReadiness(repos, sessionId, evidence);
  await recordLevelsAndMemory(repos, sessionId, evidence);
  await recordTargetSkills(repos, sessionId, evidence);
}

/** Phase 20, 35. The levels and the memory of the saved glosses a session asked. */
async function recordLevelsAndMemory(repos: Repos, sessionId: string, evidence: SessionEvidence): Promise<void> {
  const rows = await repos.progress.findRows({
    enrollmentId: evidence.enrollmentId,
    glossIds: [...new Set(evidence.answers.map((answer) => answer.glossId))],
    savedBy: null,
  });
  if (rows.length === 0) return;
  const outcome = evaluateSession(rows, evidence.answers, evidence.day);
  await repos.progress.updateRows({ enrollmentId: evidence.enrollmentId, rows: outcome.changed });
  await repos.progress.insertSnapshot({ sessionId, rows: outcome.snapshot });

  // Phase 35 (spec D4). The same answers, as memory. `rows` exist only for saved
  // glosses, so an answer about an unsaved one counts for nothing here too.
  const saved = new Set(rows.map((row) => row.glossId));
  const before = await repos.memory.findRows({ enrollmentId: evidence.enrollmentId, glossIds: [...saved] });
  const memory = applySession(
    before,
    evidence.answers.filter((answer) => saved.has(answer.glossId)),
    evidence.day,
  );
  await repos.memory.upsertRows({ enrollmentId: evidence.enrollmentId, rows: memory });
}

/**
 * Phase 65 (spec D2, D3, R1). The readiness of every target active on the session's day that
 * holds a word it asked: each counted skill moved by the answers in order. Runs before
 * recordLevelsAndMemory, because a skill with no row starts from gloss_memory as it stood before
 * this session. The recompute (db/progressRecompute.ts) repeats it, call for call.
 */
async function recordReadiness(repos: Repos, sessionId: string, evidence: SessionEvidence): Promise<void> {
  const glossIds = [...new Set(evidence.answers.map((answer) => answer.glossId))];
  const targets = await repos.target.listActiveHolding(evidence.enrollmentId, glossIds, evidence.day, evidence.lastAnsweredAt);
  if (targets.length === 0) return;
  const before = await repos.targetReadiness.findRows(targets.map((target) => target.id), glossIds);
  const memory = await repos.memory.findRows({ enrollmentId: evidence.enrollmentId, glossIds });
  const write = readinessSessionWrite({ sessionId, day: evidence.day, targets, before, memory, answers: evidence.answers });
  await repos.targetReadiness.upsertRows(write.rows);
  await repos.targetReadiness.insertEvents(write.events, evidence.lastAnsweredAt);
}

/**
 * Phase 57 (spec D4, D6, D10). The target skills of every target active on the session's day
 * that holds a word it asked, whatever path the session is on, each against its own cap, and
 * the day each word it asked started. Targets are read as they stood at the session's last
 * answer (listActiveHolding), so the recompute (db/progressRecompute.ts) replays this exactly.
 */
async function recordTargetSkills(repos: Repos, sessionId: string, evidence: SessionEvidence): Promise<void> {
  const glossIds = [...new Set(evidence.answers.map((answer) => answer.glossId))];
  const targets = await repos.target.listActiveHolding(evidence.enrollmentId, glossIds, evidence.day, evidence.lastAnsweredAt);
  if (targets.length === 0) return;
  const before = await repos.targetSkills.findRows(targets.map((target) => target.id), glossIds);
  // Phase 65b (spec D2): a session chosen past its budget moves its own target only for its owed words.
  const past = await repos.target.findPastBudget(sessionId, targets.map((target) => target.id));
  const planOnly = past && { targetId: past.targetId, glossIds: past.owedGlossIds };
  const write = targetSessionWrite({ sessionId, day: evidence.day, targets, before, answers: evidence.answers, planOnly });
  await repos.targetSkills.upsertRows(write.rows);
  await repos.targetSkills.insertEvents(write.events, evidence.lastAnsweredAt);
  for (const started of write.started) await repos.target.markStarted(started.targetId, started.glossIds, evidence.day);
}

/**
 * Phase 20, 34; final review I1. Skips an open (preparing or ready) session on `day`: its
 * status changes conditionally, so a job or an end that got there first leaves it as it is; a
 * card held for its second try is given up first, as "show the answer" would; and the answers
 * given before the skip count toward progress (recordProgress, which takes the progress lock
 * after this row). True when this call skipped it. The caller asks for its path's next stock,
 * if any, after: ADR 0014 R4.
 */
export async function skipOpenSession(repos: Repos, sessionId: string, enrollmentId: string, day: string): Promise<boolean> {
  if (!(await closeOpenSession(repos, sessionId, day))) return false;
  await recordProgress(repos, sessionId, enrollmentId);
  return true;
}

/**
 * Final review I1, re-review N2. The first half of skipOpenSession: the session's row skipped
 * on `day` and a held card given up, before any progress lock. A use case that skips several
 * sessions closes every one first and records their progress after (ADR 0014 R4): a session row
 * changed while that lock is held would wait on an end of that session, which holds its row and
 * waits for the lock. True when this call skipped it.
 */
export async function closeOpenSession(repos: Repos, sessionId: string, day: string): Promise<boolean> {
  const changed = await repos.session.transition(sessionId, ['preparing', 'ready'], 'skipped', day);
  if (changed) await repos.session.resolvePendingRetry(sessionId, { text: '', verdict: 'gave_up' });
  return changed;
}

/**
 * Final review I1-c. The learner day a target's end skips its started session on: the day of
 * the session's last answer, so the reviews its answers write are dated when they were given,
 * not when the end found them; `today` when it has none.
 */
export async function lastAnswerDay(repos: Repos, userId: string, sessionId: string, today: string): Promise<string> {
  const at = await repos.session.findLastAnswerAt(sessionId);
  return at === null ? today : learnerDay(repos, userId, at.getTime());
}
