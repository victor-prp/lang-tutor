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

// Phase 66 (spec D2). An explanation asked for a card held for its second try:
// the text that will be graded is not known yet.
export class RetryPending extends Error {
  constructor(readonly questionId: string) {
    super(`question ${questionId} waits for its second try`);
    this.name = 'RetryPending';
  }
}

// Phase 39 (spec D10). A typed answer written in another alphabet than the card's
// answer language: refused ungraded, the card stays as it was.
export class WrongScript extends Error {
  constructor(
    readonly questionId: string,
    readonly language: string,
  ) {
    super(`the answer to ${questionId} is not written in ${language}'s alphabet`);
    this.name = 'WrongScript';
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

/** Phase 28 (ADR 0008). The actor may not do this to that enrollment. `action` is
 *  a permission name, or a grant action such as 'grant.accept'. The route
 *  answers 403 with a fixed body; the detail is only in the access_denied log. */
export class AccessDenied extends Error {
  constructor(
    readonly actorUserId: string,
    readonly enrollmentId: string,
    readonly action: string,
  ) {
    super(`${actorUserId} may not ${action} on ${enrollmentId}`);
    this.name = 'AccessDenied';
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

/** Phase 28. This person already holds a grant on this list, pending or accepted. */
export class GrantExists extends Error {
  constructor(
    readonly enrollmentId: string,
    readonly granteeUserId: string,
  ) {
    super(`${granteeUserId} already holds a grant on ${enrollmentId}`);
    this.name = 'GrantExists';
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

/** Phase 18, keyed on the gloss since phase 31. A save item failed one of the
 *  gloss checks of `saveable` (repo/vocabulary.ts): the gloss is merged away or
 *  not in the enrollment's source language, its lexeme is not in the target
 *  language, its variant is not a form of that lexeme, or that form renders
 *  none of the gloss's senses in the source language. */
export class InvalidVocabularyEntry extends Error {
  constructor(readonly glossId: string) {
    super(`gloss ${glossId} cannot be saved here`);
    this.name = 'InvalidVocabularyEntry';
  }
}

/** Phase 31 (spec D14). A gloss whose learner language is not the enrollment's:
 *  the one invariant the explicit key brings. A kind of InvalidVocabularyEntry,
 *  so every route that answers that one with a 400 answers this one too. */
export class GlossLanguageMismatch extends InvalidVocabularyEntry {
  constructor(glossId: string) {
    super(glossId);
    this.name = 'GlossLanguageMismatch';
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

/** Phase 19. The enrollment already has an open session of the kind asked
 *  for. Phase 43: a started one or one in stock. Phase 57 (ADR 0014): on the path
 *  asked for (sessions_one_started_per_path, sessions_one_stock_per_path). */
export class SessionOpen extends Error {
  constructor(readonly enrollmentId: string) {
    super(`enrollment ${enrollmentId} already has an open session`);
    this.name = 'SessionOpen';
  }
}

/** Phase 61 (spec D1). A question-types read or session, asked by an account that is not a tester. */
export class NotATester extends Error {
  constructor(readonly userId: string) {
    super(`user ${userId} is not a tester`);
    this.name = 'NotATester';
  }
}

/** Phase 61 (spec D2). The gloss is not saved in the enrollment's list. */
export class GlossNotSaved extends Error {
  constructor(readonly glossId: string) {
    super(`gloss ${glossId} is not saved in this list`);
    this.name = 'GlossNotSaved';
  }
}

/** Phase 61 (spec D3). A question type the word, or the device, cannot have. */
export class QuestionTypeUnavailable extends Error {
  constructor(readonly type: string, readonly reason: string) {
    super(`question type ${type} is unavailable: ${reason}`);
    this.name = 'QuestionTypeUnavailable';
  }
}

/** Phase 61 (spec D2, builder check). The session asked for a rendering the read did not answer. */
export class RenderingMismatch extends Error {
  constructor(readonly senseId: string) {
    super(`sense ${senseId} is not the rendering a question-types session of this gloss uses`);
    this.name = 'RenderingMismatch';
  }
}

/** Phase 61 (D7). The enrollment's first, seeded session waits in stock, which nothing retires. */
export class SeedPending extends Error {
  constructor(readonly enrollmentId: string) {
    super(`enrollment ${enrollmentId} has its seeded first session waiting`);
    this.name = 'SeedPending';
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

/** Phase 19. The model's distractors were unreadable or empty, or no dictionary
 *  rows are left for any pick. A card that fails validation is refused, not thrown
 *  (phase 48, spec D1, D5). Thrown inside the job so pg-boss retries it; never on
 *  the wire. */
export class InvalidDistractors extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`distractors for session ${sessionId} were refused: ${reason}`);
    this.name = 'InvalidDistractors';
  }
}

/** Phase 28. No grant has this id. */
export class GrantNotFound extends Error {
  constructor(readonly grantId: string) {
    super(`no grant ${grantId}`);
    this.name = 'GrantNotFound';
  }
}

/** Phase 28 (spec D3). An invite names a language the student is not learning. */
export class NotLearning extends Error {
  constructor(
    readonly userId: string,
    readonly targetLanguage: string,
  ) {
    super(`${userId} is not learning ${targetLanguage}`);
    this.name = 'NotLearning';
  }
}

/** Phase 28. Nobody holds a grant on their own list. */
export class OwnList extends Error {
  constructor(readonly userId: string) {
    super(`${userId} cannot be granted their own list`);
    this.name = 'OwnList';
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

// Phase 69 (spec D10). No Words for me run has this id, or it has no such card (404).
export class DiscoveryNotFound extends Error {
  constructor(readonly runId: string, readonly position?: number) {
    super(position === undefined ? `no discovery run ${runId}` : `no card ${position} in discovery run ${runId}`);
    this.name = 'DiscoveryNotFound';
  }
}

// Phase 69. A profile asked twice, a run started without one, or a run in the wrong
// state for the request: an answer once it lists, a save while a row is looked up (409).
export class DiscoveryConflict extends Error {
  constructor(readonly id: string, readonly reason: string) {
    super(`discovery ${id}: ${reason}`);
    this.name = 'DiscoveryConflict';
  }
}

// Phase 69. A change a list row cannot take, as a photo row's (400).
export class InvalidDiscoveryItem extends Error {
  constructor(readonly runId: string, readonly position: number, readonly reason: string) {
    super(`discovery run ${runId} row ${position}: ${reason}`);
    this.name = 'InvalidDiscoveryItem';
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
// Phase 69: a Words for me card's lookup throws it too, naming its run.
export class SenseMatchUnreadable extends Error {
  constructor(readonly listId: string, readonly position: number) {
    super(`the sense match for ${listId} row ${position} was unreadable`);
    this.name = 'SenseMatchUnreadable';
  }
}

/** Phase 29 (spec D16). The email provider did not take a sign-in code. */
export class EmailNotSent extends Error {
  constructor(readonly status: number | 'timeout' | 'network') {
    super(`sign-in email not sent (${status})`);
    this.name = 'EmailNotSent';
  }
}

/** Phase 52 (spec D7). Expo's push service could not be reached, refused the request, ran out
 *  of time, or answered with something other than tickets or receipts. One error for every
 *  cause; the tick records it against the learner's reminder and goes on to the next. */
export class PushUnavailable extends Error {
  constructor(readonly detail: number | 'timeout' | 'network' | 'unreadable') {
    super(`push service unavailable (${detail})`);
    this.name = 'PushUnavailable';
  }
}

/** Phase 52 (spec D1). The app reported a time zone `Intl` does not know. The
 *  route answers 400; a wrong zone would give the learner the wrong day. */
export class InvalidTimeZone extends Error {
  constructor(readonly timeZone: string) {
    super(`${timeZone} is not a time zone`);
    this.name = 'InvalidTimeZone';
  }
}

/** Phase 52 (spec D6). The reminder a tap reports is not the caller's, or does not exist, or
 *  the id is not even a uuid. One error for all three, so the route's 404 cannot tell a
 *  stranger's reminder from a missing one (ADR 0009 R7). */
export class ReminderNotFound extends Error {
  constructor(readonly reminderId: string) {
    super(`no reminder ${reminderId}`);
    this.name = 'ReminderNotFound';
  }
}

/** Phase 53 (spec D2, D13). A target that does not exist, or an id that is not even a uuid:
 *  one error for both, so the route's 404 cannot tell them apart. Another learner's target
 *  is AccessDenied, as another learner's photo import is. */
export class TargetNotFound extends Error {
  constructor(readonly targetId: string) {
    super(`no target ${targetId}`);
    this.name = 'TargetNotFound';
  }
}

/** Phase 53 (spec D1, ruling R-D10). A target that cannot be: a due date on or before the
 *  learner's today, or, on create, no word to hold once its photos and typed words are
 *  saved (400). */
export class InvalidTarget extends Error {
  constructor(readonly reason: 'due_date' | 'no_words') {
    super(`invalid target: ${reason}`);
    this.name = 'InvalidTarget';
  }
}

/** Phase 53 (spec D1). A change to a target that is no longer active: ended early, or its
 *  date has come (409). */
export class TargetClosed extends Error {
  constructor(readonly targetId: string) {
    super(`target ${targetId} is closed`);
    this.name = 'TargetClosed';
  }
}

/** Phase 29 (spec D12). The signed-in user already has a profile. */
export class ProfileExists extends Error {
  constructor(readonly userId: string) {
    super(`user ${userId} already has a profile`);
    this.name = 'ProfileExists';
  }
}
