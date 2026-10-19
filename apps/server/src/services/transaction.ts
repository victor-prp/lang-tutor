import type { EnrollmentRepo } from '../repo/enrollments';
import type { GlossRepo } from '../repo/glosses';
import type { GlossFamiliesRepo } from '../repo/glossFamilies';
import type { GrantRepo } from '../repo/grants';
import type { JobRepo } from '../repo/jobs';
import type { MemoryRepo } from '../repo/memory';
import type { ModelCallRepo } from '../repo/modelCalls';
import type { PhotoImportRepo } from '../repo/photoImports';
import type { PronunciationRepo } from '../repo/pronunciationScores';
import type { ProgressRepo } from '../repo/progress';
import type { ReminderRepo } from '../repo/reminders';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import type { TargetRepo } from '../repo/targets';
import type { TargetBudgetRepo } from '../repo/targetBudgets';
import type { TargetReadinessRepo } from '../repo/targetReadiness';
import type { TargetSkillRepo } from '../repo/targetSkills';
import type { UserRepo } from '../repo/users';
import type { DictRepo } from '../repo/dictionary';
import type { VocabularyRepo } from '../repo/vocabulary';

// The repositories composition.ts binds to one transaction. This module holds
// types only — R2 lets services reference repo modules as types, and nothing
// here is a value, so no service gains a route to Drizzle through it.
export type Repos = {
  session: SessionRepo;
  question: QuestionRepo;
  user: UserRepo;
  enrollment: EnrollmentRepo;
  grant: GrantRepo;
  dict: DictRepo;
  gloss: GlossRepo;
  vocabulary: VocabularyRepo;
  progress: ProgressRepo;
  memory: MemoryRepo;
  glossFamilies: GlossFamiliesRepo;
  jobs: JobRepo;
  photoImport: PhotoImportRepo;
  // Phase 47 (spec D5). Written only by the model-call recorder.
  modelCall: ModelCallRepo;
  // Phase 50 (spec D3). Read before and written after a sound-alike call.
  pronunciation: PronunciationRepo;
  // Phase 52 (spec D2, D4, D6). Settings, devices and the log of each tick's decisions.
  reminders: ReminderRepo;
  // Phase 53 (spec D1, D8). Targets, their words, their log and each session's split.
  target: TargetRepo;
  // Phase 57 (spec D3, D4). Target skills and their log, written when a session ends.
  targetSkills: TargetSkillRepo;
  // Phase 65 (spec D2, D3). Target readiness and its log, written when a session ends.
  targetReadiness: TargetReadinessRepo;
  // Phase 65 (spec D7). Today's budget per target, set at its path's first session of the day.
  targetBudgets: TargetBudgetRepo;
};

/**
 * One use case, one transaction — ADR 0001 R8's boundary, expressed without a
 * database handle. The repositories arrive already bound, so nothing in
 * services/ names Drizzle, a pool, or a `Tx`.
 */
export type Transaction = <T>(run: (repos: Repos) => Promise<T>) => Promise<T>;
