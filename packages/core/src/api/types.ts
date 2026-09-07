import type { z } from 'zod';

import type {
  AnswerRecordSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CreateUserRequestSchema,
  ErrorSchema,
  HealthResponseSchema,
  LoginRequestSchema,
  MissedQuestionSchema,
  MultipleChoiceQuestionSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
  PositionSchema,
  QuestionSchema,
  ScoreSchema,
  UserSchema,
} from './schemas';

// Every type here is inferred. The alternative — schemas on the server and
// hand-written types here — is two definitions of one contract, free to drift.
// Removing that freedom is the whole point of this phase, so a hand-written
// type in this file is a bug, not a shortcut. Prose about *why* each shape is
// the way it is lives next to its schema in ./schemas.
//
// The `import type` above matters: it keeps this module free of any runtime
// import of Zod, which is what lets ./index.ts stay a pure type barrel.

export type MultipleChoiceQuestion = z.infer<typeof MultipleChoiceQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type MissedQuestion = z.infer<typeof MissedQuestionSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type NextStepRequest = z.infer<typeof NextStepRequestSchema>;
export type NextStepResponse = z.infer<typeof NextStepResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type User = z.infer<typeof UserSchema>;
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
