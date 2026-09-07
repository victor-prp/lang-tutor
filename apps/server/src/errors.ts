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

export class InvalidLanguagePair extends Error {
  constructor(readonly languageCode: string) {
    super(`native and target language are both ${languageCode}`);
    this.name = 'InvalidLanguagePair';
  }
}
