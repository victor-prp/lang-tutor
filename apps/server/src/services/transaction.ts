import type { EnrollmentRepo } from '../repo/enrollments';
import type { GlossRepo } from '../repo/glosses';
import type { GrantRepo } from '../repo/grants';
import type { JobRepo } from '../repo/jobs';
import type { PhotoImportRepo } from '../repo/photoImports';
import type { ProgressRepo } from '../repo/progress';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
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
  jobs: JobRepo;
  photoImport: PhotoImportRepo;
};

/**
 * One use case, one transaction — ADR 0001 R8's boundary, expressed without a
 * database handle. The repositories arrive already bound, so nothing in
 * services/ names Drizzle, a pool, or a `Tx`.
 */
export type Transaction = <T>(run: (repos: Repos) => Promise<T>) => Promise<T>;
