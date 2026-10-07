import type { z } from 'zod';

import type {
  AnswerRecordSchema,
  CreateEnrollmentRequestSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CreateUserRequestSchema,
  CurrentSessionResponseSchema,
  CurrentSessionSchema,
  EnrollmentSchema,
  ErrorSchema,
  HealthResponseSchema,
  KnowledgeDimensionSchema,
  LanguageCodeSchema,
  LevelSchema,
  LlmCorrectionSchema,
  LlmDistractorsSchema,
  LlmEntrySchema,
  LlmPhotoReadingSchema,
  LlmReconciliationSchema,
  LlmRenderingSchema,
  LlmSenseMatchSchema,
  LlmSenseSchema,
  LlmTranslationSchema,
  LoginRequestSchema,
  MissedQuestionSchema,
  MultipleChoiceQuestionSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
  PartOfSpeechSchema,
  PhotoImportCreateRequestSchema,
  PhotoImportItemReasonSchema,
  PhotoImportItemSchema,
  PhotoImportItemStatusSchema,
  PhotoImportItemUpdateSchema,
  PhotoImportOptionSchema,
  PhotoImportSchema,
  PhotoImportStatusSchema,
  PhotoImportSummarySchema,
  PositionSchema,
  QuestionSchema,
  ReverseChoiceQuestionSchema,
  SaveVocabularyRequestSchema,
  SaveVocabularyResponseSchema,
  ScoreSchema,
  SenseProgressSchema,
  SessionProgressItemSchema,
  SessionSourceSchema,
  SessionStatusSchema,
  SessionViewSchema,
  SkipSessionResponseSchema,
  TypedTranslationQuestionSchema,
  ListenChoiceQuestionSchema,
  DictationQuestionSchema,
  MatchingBoardSchema,
  MatchingQuestionSchema,
  LetterTilesQuestionSchema,
  TypedVerdictSchema,
  ReadAloudQuestionSchema,
  SayTranslationQuestionSchema,
  SpokenVerdictSchema,
  AnswerVerdictSchema,
  SpeechMimeTypeSchema,
  SpeechVerdictSchema,
  SpeechAnswerRequestSchema,
  SpeechAnswerResponseSchema,
  LlmTranscriptSchema,
  TranslationCorrectionSchema,
  TranslationGuardReasonSchema,
  TranslationKindSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
  TranslationSenseSchema,
  UserSchema,
  VocabularyEntryInputSchema,
  VocabularyPageQuerySchema,
  VocabularyPageSchema,
  VocabularySenseSchema,
  VocabularyWordDetailSchema,
  VocabularyWordQuerySchema,
  VocabularyWordSchema,
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
export type ReverseChoiceQuestion = z.infer<typeof ReverseChoiceQuestionSchema>;
export type TypedTranslationQuestion = z.infer<typeof TypedTranslationQuestionSchema>;
export type ListenChoiceQuestion = z.infer<typeof ListenChoiceQuestionSchema>;
export type DictationQuestion = z.infer<typeof DictationQuestionSchema>;
export type MatchingBoard = z.infer<typeof MatchingBoardSchema>;
export type MatchingQuestion = z.infer<typeof MatchingQuestionSchema>;
export type LetterTilesQuestion = z.infer<typeof LetterTilesQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type TypedVerdict = z.infer<typeof TypedVerdictSchema>;
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
export type TranslationGuardReason = z.infer<typeof TranslationGuardReasonSchema>;
export type TranslationKind = z.infer<typeof TranslationKindSchema>;
export type PartOfSpeech = z.infer<typeof PartOfSpeechSchema>;
export type TranslationSense = z.infer<typeof TranslationSenseSchema>;
export type TranslationRequest = z.infer<typeof TranslationRequestSchema>;
export type TranslationResponse = z.infer<typeof TranslationResponseSchema>;
export type TranslationCorrection = z.infer<typeof TranslationCorrectionSchema>;
export type LlmTranslation = z.infer<typeof LlmTranslationSchema>;
export type LlmCorrection = z.infer<typeof LlmCorrectionSchema>;
export type LlmSense = z.infer<typeof LlmSenseSchema>;
export type LlmEntry = z.infer<typeof LlmEntrySchema>;
export type LlmRendering = z.infer<typeof LlmRenderingSchema>;
export type LlmReconciliation = z.infer<typeof LlmReconciliationSchema>;
export type Enrollment = z.infer<typeof EnrollmentSchema>;
export type CreateEnrollmentRequest = z.infer<typeof CreateEnrollmentRequestSchema>;
export type LanguageCode = z.infer<typeof LanguageCodeSchema>;
export type VocabularyEntryInput = z.infer<typeof VocabularyEntryInputSchema>;
export type SaveVocabularyRequest = z.infer<typeof SaveVocabularyRequestSchema>;
export type SaveVocabularyResponse = z.infer<typeof SaveVocabularyResponseSchema>;
export type VocabularyPageQuery = z.infer<typeof VocabularyPageQuerySchema>;
export type VocabularyWord = z.infer<typeof VocabularyWordSchema>;
export type VocabularyPage = z.infer<typeof VocabularyPageSchema>;
export type VocabularySense = z.infer<typeof VocabularySenseSchema>;
export type VocabularyWordDetail = z.infer<typeof VocabularyWordDetailSchema>;
export type VocabularyWordQuery = z.infer<typeof VocabularyWordQuerySchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionSource = z.infer<typeof SessionSourceSchema>;
export type LlmDistractors = z.infer<typeof LlmDistractorsSchema>;
export type SessionView = z.infer<typeof SessionViewSchema>;
export type CurrentSession = z.infer<typeof CurrentSessionSchema>;
export type CurrentSessionResponse = z.infer<typeof CurrentSessionResponseSchema>;
export type KnowledgeDimension = z.infer<typeof KnowledgeDimensionSchema>;
export type SenseProgress = z.infer<typeof SenseProgressSchema>;
export type SessionProgressItem = z.infer<typeof SessionProgressItemSchema>;
export type SkipSessionResponse = z.infer<typeof SkipSessionResponseSchema>;
export type ReadAloudQuestion = z.infer<typeof ReadAloudQuestionSchema>;
export type SayTranslationQuestion = z.infer<typeof SayTranslationQuestionSchema>;
export type SpokenVerdict = z.infer<typeof SpokenVerdictSchema>;
export type AnswerVerdict = z.infer<typeof AnswerVerdictSchema>;
export type SpeechMimeType = z.infer<typeof SpeechMimeTypeSchema>;
export type SpeechVerdict = z.infer<typeof SpeechVerdictSchema>;
export type SpeechAnswerRequest = z.infer<typeof SpeechAnswerRequestSchema>;
export type SpeechAnswerResponse = z.infer<typeof SpeechAnswerResponseSchema>;
export type LlmTranscript = z.infer<typeof LlmTranscriptSchema>;
export type PhotoImportCreateRequest = z.infer<typeof PhotoImportCreateRequestSchema>;
export type PhotoImportStatus = z.infer<typeof PhotoImportStatusSchema>;
export type PhotoImportItemStatus = z.infer<typeof PhotoImportItemStatusSchema>;
export type PhotoImportItemReason = z.infer<typeof PhotoImportItemReasonSchema>;
export type PhotoImportOption = z.infer<typeof PhotoImportOptionSchema>;
export type PhotoImportItem = z.infer<typeof PhotoImportItemSchema>;
export type PhotoImportSummary = z.infer<typeof PhotoImportSummarySchema>;
export type PhotoImport = z.infer<typeof PhotoImportSchema>;
export type PhotoImportItemUpdate = z.infer<typeof PhotoImportItemUpdateSchema>;
export type LlmPhotoReading = z.infer<typeof LlmPhotoReadingSchema>;
export type LlmSenseMatch = z.infer<typeof LlmSenseMatchSchema>;
