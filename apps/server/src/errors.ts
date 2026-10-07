// Classes because subclassing Error requires one, and because `instanceof` is
// the cleanest way for the transport layer to map a domain failure to a status
// code. These are the only classes this phase adds.

export class SessionNotFound extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} not found`);
    this.name = 'SessionNotFound';
  }
}

export class QuestionDesynced extends Error {
  constructor(readonly questionId: string) {
    super(`question ${questionId} is neither the current nor the just-answered question`);
    this.name = 'QuestionDesynced';
  }
}

export class OptionOutOfRange extends Error {
  constructor(readonly optionIndex: number) {
    super(`option_index ${optionIndex} is out of range for this question`);
    this.name = 'OptionOutOfRange';
  }
}

// Phase 23. An option index sent for a typed card, or text for a choice: a
// malformed request, not a desync.
export class AnswerKindMismatch extends Error {
  constructor(readonly questionId: string) {
    super(`the answer to ${questionId} is not the kind its question takes`);
    this.name = 'AnswerKindMismatch';
  }
}

export class UsernameTaken extends Error {
  constructor(readonly username: string) {
    super(`username ${username} is already taken`);
    this.name = 'UsernameTaken';
  }
}

// `identifier` is a username when a login fails and a user id when a session is
// started for someone who does not exist. One error, because the transport
// answer is the same 404 either way.
export class UserNotFound extends Error {
  constructor(readonly identifier: string) {
    super(`no user matches ${identifier}`);
    this.name = 'UserNotFound';
  }
}

export class EnrollmentNotFound extends Error {
  constructor(readonly enrollmentId: string) {
    super(`no enrollment ${enrollmentId}`);
    this.name = 'EnrollmentNotFound';
  }
}

export class AlreadyEnrolled extends Error {
  constructor(
    readonly userId: string,
    readonly targetLanguage: string,
  ) {
    super(`user ${userId} is already enrolled in ${targetLanguage}`);
    this.name = 'AlreadyEnrolled';
  }
}

/** A session draws SESSION_LENGTH questions; a pool smaller than that cannot
 *  start one. Before phase 16 this surfaced as a plain Error from pickQuestions
 *  and a 500. */
export class InsufficientQuestions extends Error {
  constructor(
    readonly enrollmentId: string,
    readonly available: number,
  ) {
    super(`enrollment ${enrollmentId} has ${available} questions, too few for a session`);
    this.name = 'InsufficientQuestions';
  }
}

/** The provider could not be reached, refused the request, or ran out of time.
 *  One error for every cause the learner can do nothing different about; the
 *  distinguishing detail goes in the log, not the status. */
export class LlmUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`language model unavailable: ${detail}`);
    this.name = 'LlmUnavailable';
  }
}

/** The provider answered, but not with something that satisfies the schema.
 *  Separate from LlmUnavailable because the operator needs to know whether the
 *  provider failed or the prompt did, even though both map to 502. */
export class TranslationUnreadable extends Error {
  constructor(readonly rawExcerpt: string) {
    super('the model response did not match the expected shape');
    this.name = 'TranslationUnreadable';
  }
}

/** A repair whose renderings would drop a sense the form is already serving.
 *  Not a bad request and not a provider failure: it is the fail-closed guard in
 *  `repo/dictionary.ts`'s `repairVariantRenderings`, and the translate use case
 *  catches it and serves the stored answer — see that function's comment for why
 *  dropping is worse than refusing. */
export class RepairWouldDropSense extends Error {
  constructor(
    readonly variantId: string,
    readonly senseIds: string[],
  ) {
    super(`a repair of variant ${variantId} would drop ${senseIds.length} rendered sense(s)`);
    this.name = 'RepairWouldDropSense';
  }
}

/** Phase 18. A translation named an enrollment whose pair is not the lookup's. */
export class PairNotEnrolled extends Error {
  constructor(
    readonly enrollmentId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`enrollment ${enrollmentId} does not cover ${from} → ${to}`);
    this.name = 'PairNotEnrolled';
  }
}

/** Phase 18. A save item failed a check: its sense is not in the enrollment's
 *  target language, its variant is not a form of that lexeme, or that form has
 *  no rendering of the sense in the enrollment's source language. */
export class InvalidVocabularyEntry extends Error {
  constructor(readonly senseId: string) {
    super(`sense ${senseId} cannot be saved here`);
    this.name = 'InvalidVocabularyEntry';
  }
}

/** Phase 21. No lexeme with this lemma in the enrollment's target language. */
export class WordNotFound extends Error {
  constructor(readonly lemma: string) {
    super(`no word ${lemma}`);
    this.name = 'WordNotFound';
  }
}

/** Phase 18. A list cursor this server did not issue. A schema cannot see inside
 *  the base64, so this is decided in domain/vocabulary.ts's decodeCursor. */
export class InvalidCursor extends Error {
  constructor() {
    super('malformed vocabulary cursor');
    this.name = 'InvalidCursor';
  }
}

/** Phase 19. The enrollment already has a preparing or ready session
 *  (sessions_one_open_per_enrollment). */
export class SessionOpen extends Error {
  constructor(readonly enrollmentId: string) {
    super(`enrollment ${enrollmentId} already has an open session`);
    this.name = 'SessionOpen';
  }
}

/** Phase 19. The next session is built from the saved list, and it is empty. */
export class NoSavedWords extends Error {
  constructor(readonly enrollmentId: string) {
    super(`enrollment ${enrollmentId} has no saved words to practise`);
    this.name = 'NoSavedWords';
  }
}

/** Phase 19. Only a preparing or ready session can be skipped. */
export class SessionNotSkippable extends Error {
  constructor(
    readonly sessionId: string,
    readonly status: string,
  ) {
    super(`session ${sessionId} is ${status} and cannot be skipped`);
    this.name = 'SessionNotSkippable';
  }
}

/** Phase 19. An answer to a session that is not ready: still preparing, skipped
 *  or failed. A completed session keeps today's replay path. */
export class SessionNotReady extends Error {
  constructor(
    readonly sessionId: string,
    readonly status: string,
  ) {
    super(`session ${sessionId} is ${status}, not ready`);
    this.name = 'SessionNotReady';
  }
}

/** Phase 19. The model's distractors were unreadable or failed validation.
 *  Thrown inside the job so pg-boss retries it; never on the wire. */
export class InvalidDistractors extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`distractors for session ${sessionId} were refused: ${reason}`);
    this.name = 'InvalidDistractors';
  }
}

// Phase 26. An import, or a row of one, that does not exist.
export class PhotoImportNotFound extends Error {
  constructor(readonly importId: string, readonly position?: number) {
    super(position === undefined ? `no photo import ${importId}` : `no row ${position} in photo import ${importId}`);
    this.name = 'PhotoImportNotFound';
  }
}

// Phase 26. The import is in the wrong state for the request: a row still
// being looked up, an import saved or discarded, a save before it is ready (409).
export class PhotoImportConflict extends Error {
  constructor(readonly importId: string, readonly reason: string) {
    super(`photo import ${importId}: ${reason}`);
    this.name = 'PhotoImportConflict';
  }
}

// Phase 26. A change a row cannot take: a sense that is not one of its options,
// or a tick on a row with none (400).
export class InvalidPhotoImportItem extends Error {
  constructor(readonly importId: string, readonly position: number, readonly reason: string) {
    super(`photo import ${importId} row ${position}: ${reason}`);
    this.name = 'InvalidPhotoImportItem';
  }
}

// Phase 26. The reader's answer was not the schema. Thrown inside a job, so
// pg-boss retries it.
export class PhotoUnreadable extends Error {
  constructor(readonly importId: string) {
    super(`the reading of photo import ${importId} was unreadable`);
    this.name = 'PhotoUnreadable';
  }
}

// Phase 26. The match call's answer was not the schema. A retry, like the above.
export class SenseMatchUnreadable extends Error {
  constructor(readonly importId: string, readonly position: number) {
    super(`the sense match for photo import ${importId} row ${position} was unreadable`);
    this.name = 'SenseMatchUnreadable';
  }
}
