import type {
  CreateSessionResponse,
  CurrentSessionResponse,
  Enrollment,
  JudgedAnswerRequest,
  JudgedAnswerResponse,
  NextStepRequest,
  NextStepResponse,
  SaveVocabularyResponse,
  SessionView,
  SpeechAnswerRequest,
  SpeechAnswerResponse,
  TranslationResponse,
  VocabularyEntryInput,
  VocabularyPage,
} from '@lang-tutor/core/api';
import {
  BotSignInResponseSchema,
  CreateSessionResponseSchema,
  CurrentSessionResponseSchema,
  EnrollmentListSchema,
  EnrollmentSchema,
  JudgedAnswerResponseSchema,
  NextStepResponseSchema,
  SaveVocabularyResponseSchema,
  SessionViewSchema,
  SignOutResponseSchema,
  SpeechAnswerResponseSchema,
  TranslationResponseSchema,
  VocabularyPageSchema,
} from '@lang-tutor/core/api/schemas';
import type { z } from 'zod';

import type { Language } from './words.ts';

/**
 * Spec D16, D12. The public API exactly as the app calls it, and the bot route. A request that
 * fails for any reason (a status other than 2xx, a network error, a timeout, or a body that does
 * not match the contract in packages/core) is an ApiError: the driver ends that bot's day on it
 * and goes on to the next bot (D19). Anything else thrown is a bug in the driver.
 */
export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    /** The HTTP status; null when no response came. */
    readonly status: number | null,
    readonly body: string,
  ) {
    super(`${method} ${path} failed: ${status ?? 'no response'} ${body.slice(0, 200)}`);
    this.name = 'ApiError';
  }
}

/** The bot-only route (D12): the secret, never a cookie. */
export interface BotRoute {
  /** A one-day session for the bot, as the whole `Cookie` header value. */
  signIn(name: string): Promise<string>;
  setDay(name: string, day: string): Promise<void>;
}

/** What one signed-in bot calls, the app's own requests. */
export interface BotApi {
  enrollments(): Promise<Enrollment[]>;
  enroll(target: Language): Promise<Enrollment>;
  translate(text: string, from: Language, enrollmentId: string): Promise<TranslationResponse>;
  save(enrollmentId: string, entries: VocabularyEntryInput[]): Promise<SaveVocabularyResponse>;
  /** The newest page of the word list: one item per lemma, newest save first. */
  vocabulary(enrollmentId: string): Promise<VocabularyPage>;
  createSession(enrollmentId: string, devices: { listening: boolean; speaking: boolean }): Promise<CreateSessionResponse>;
  currentSession(enrollmentId: string): Promise<CurrentSessionResponse>;
  session(id: string): Promise<SessionView>;
  skip(id: string): Promise<void>;
  nextStep(id: string, body: NextStepRequest): Promise<NextStepResponse>;
  speech(id: string, body: SpeechAnswerRequest): Promise<SpeechAnswerResponse>;
  judged(id: string, body: JudgedAnswerRequest): Promise<JudgedAnswerResponse>;
  signOut(): Promise<void>;
}

/** Long enough for a judged answer or a transcription, which call a model. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** The phone's sign-out: no Origin, the app's scheme in `expo-origin`, which Better Auth admits. */
const APP_ORIGIN = 'langtutor://';

export function createApi(opts: { baseUrl: string; secret: string; fetch?: typeof fetch; timeoutMs?: number }) {
  const base = opts.baseUrl.replace(/\/+$/u, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function call<S extends z.ZodType | null>(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
    schema: S,
  ): Promise<S extends z.ZodType ? z.infer<S> : void> {
    let res: Response;
    try {
      res = await doFetch(`${base}/api${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ApiError(method, path, null, error instanceof Error ? error.message : String(error));
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new ApiError(method, path, res.status, text);
    if (schema === null) return undefined as never;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(method, path, res.status, `not JSON: ${text}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError(method, path, res.status, `off contract: ${parsed.error.message}`);
    return parsed.data as never;
  }

  const bearer = { authorization: `Bearer ${opts.secret}` };

  const route: BotRoute = {
    signIn: async (name) => (await call('POST', '/bots/sign-in', bearer, { name }, BotSignInResponseSchema)).cookie,
    setDay: (name, day) => call('PUT', '/bots/day', bearer, { name, day }, null),
  };

  function as(cookie: string): BotApi {
    const h = { cookie };
    return {
      enrollments: () => call('GET', '/enrollments', h, undefined, EnrollmentListSchema),
      enroll: (target) => call('POST', '/enrollments', h, { source_language: 'he', target_language: target }, EnrollmentSchema),
      translate: (text, from, enrollmentId) =>
        call('POST', '/translations', h, { text, from, to: 'he', enrollment_id: enrollmentId }, TranslationResponseSchema),
      save: (enrollmentId, entries) =>
        call('POST', `/enrollments/${enrollmentId}/vocabulary`, h, { entries }, SaveVocabularyResponseSchema),
      vocabulary: (enrollmentId) =>
        call('GET', `/enrollments/${enrollmentId}/vocabulary?limit=100`, h, undefined, VocabularyPageSchema),
      createSession: (enrollmentId, devices) =>
        call('POST', '/sessions', h, { enrollment_id: enrollmentId, ...devices }, CreateSessionResponseSchema),
      currentSession: (enrollmentId) =>
        call('GET', `/enrollments/${enrollmentId}/sessions/current`, h, undefined, CurrentSessionResponseSchema),
      session: (id) => call('GET', `/sessions/${id}`, h, undefined, SessionViewSchema),
      skip: (id) => call('POST', `/sessions/${id}/skip`, h, undefined, null),
      nextStep: (id, body) => call('POST', `/sessions/${id}/next-step`, h, body, NextStepResponseSchema),
      speech: (id, body) => call('POST', `/sessions/${id}/speech`, h, body, SpeechAnswerResponseSchema),
      judged: (id, body) => call('POST', `/sessions/${id}/judged-answer`, h, body, JudgedAnswerResponseSchema),
      signOut: () => call('POST', '/auth/sign-out', { ...h, 'expo-origin': APP_ORIGIN }, {}, SignOutResponseSchema).then(() => {}),
    };
  }

  return { route, as };
}
