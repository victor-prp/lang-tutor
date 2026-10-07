import type {
  CreateEnrollmentRequest,
  CreateGrantRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateUserRequest,
  CurrentSessionResponse,
  Enrollment,
  Grant,
  GrantList,
  LoginRequest,
  NextStepRequest,
  NextStepResponse,
  SaveVocabularyRequest,
  SaveVocabularyResponse,
  SessionView,
  SkipSessionResponse,
  SpeechAnswerRequest,
  SpeechAnswerResponse,
  TranslationRequest,
  TranslationResponse,
  User,
  VocabularyPage,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';

export class ApiError extends Error {
  // `code` is the body's `error` string when there is one: the server answers
  // several 409s (session_open, no_saved_words, …) that the status alone
  // cannot tell apart.
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(`API request failed with status ${status}${code ? ` (${code})` : ''}`);
  }
}

async function failureOf(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return new ApiError(res.status, typeof body.error === 'string' ? body.error : undefined);
  } catch {
    return new ApiError(res.status);
  }
}

/** Phase 25. A hung upload would leave the speaking card "checking" with every
 *  button disabled; past this it becomes the "couldn't check" notice. */
export const SPEECH_UPLOAD_TIMEOUT_MS = 15_000;

// Phase 28 (ADR 0008 R2). The ONE place in the app that names the actor header.
// Asserted, not a credential: the server checks what this user may do, and login
// will replace it. The client is built before anyone logs in, so the caller
// passes the id; nothing here holds it.
const ACTOR_HEADER = 'X-Acting-User-Id';
const actorHeader = (actorUserId: string | undefined): Record<string, string> =>
  actorUserId ? { [ACTOR_HEADER]: actorUserId } : {};

export type ApiClientDeps = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
};

// `baseUrl` and `fetch` are received, not read from the environment or the
// global object. The literal process.env.EXPO_PUBLIC_API_URL now lives in
// app/_layout.tsx, which is where Metro's build-time inlining still sees it.
export function createApiClient({ baseUrl, fetch }: ApiClientDeps) {
  async function postJson<TResponse>(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; actorUserId?: string } = {},
  ): Promise<TResponse> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...actorHeader(options.actorUserId) },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok) throw await failureOf(res);
    return (await res.json()) as TResponse;
  }

  async function getJson<TResponse>(path: string, actorUserId?: string): Promise<TResponse> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      ...(actorUserId ? { headers: actorHeader(actorUserId) } : {}),
    });
    if (!res.ok) throw await failureOf(res);
    return (await res.json()) as TResponse;
  }

  async function deleteResource(path: string, actorUserId?: string): Promise<void> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'DELETE',
      ...(actorUserId ? { headers: actorHeader(actorUserId) } : {}),
    });
    if (!res.ok) throw await failureOf(res);
  }

  const vocabularyPath = (enrollmentId: string) =>
    `/api/enrollments/${encodeURIComponent(enrollmentId)}/vocabulary`;

  return {
    // Identification, not authentication: there is no password to send.
    login: (request: LoginRequest) => postJson<User>('/api/login', request),
    createUser: (request: CreateUserRequest) => postJson<User>('/api/users', request),
    createSession: (request: CreateSessionRequest) =>
      postJson<CreateSessionResponse>('/api/sessions', request),
    nextStep: (sessionId: string, request: NextStepRequest) =>
      postJson<NextStepResponse>(`/api/sessions/${sessionId}/next-step`, request),
    answerBySpeech: async (sessionId: string, request: SpeechAnswerRequest) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SPEECH_UPLOAD_TIMEOUT_MS);
      try {
        return await postJson<SpeechAnswerResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/speech`,
          request,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }
    },
    getSession: (sessionId: string) =>
      getJson<SessionView>(`/api/sessions/${encodeURIComponent(sessionId)}`),
    skipSession: (sessionId: string) =>
      postJson<SkipSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/skip`, {}),
    currentSession: (enrollmentId: string) =>
      getJson<CurrentSessionResponse>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/sessions/current`),
    translate: (request: TranslationRequest) =>
      postJson<TranslationResponse>('/api/translations', request),
    listEnrollments: (userId: string) =>
      getJson<Enrollment[]>(`/api/users/${encodeURIComponent(userId)}/enrollments`),
    createEnrollment: (userId: string, request: CreateEnrollmentRequest) =>
      postJson<Enrollment>(`/api/users/${encodeURIComponent(userId)}/enrollments`, request),
    saveVocabulary: (actorUserId: string, enrollmentId: string, request: SaveVocabularyRequest) =>
      postJson<SaveVocabularyResponse>(vocabularyPath(enrollmentId), request, { actorUserId }),
    unsaveVocabulary: (actorUserId: string, enrollmentId: string, senseId: string) =>
      deleteResource(`${vocabularyPath(enrollmentId)}/senses/${encodeURIComponent(senseId)}`, actorUserId),
    listVocabulary: (enrollmentId: string, query: { cursor?: string; limit?: number; level?: number }) => {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.level !== undefined) params.set('level', String(query.level));
      const search = params.toString();
      return getJson<VocabularyPage>(`${vocabularyPath(enrollmentId)}${search ? `?${search}` : ''}`);
    },
    vocabularyWord: (enrollmentId: string, lemma: string) =>
      getJson<VocabularyWordDetail>(`${vocabularyPath(enrollmentId)}/word?lemma=${encodeURIComponent(lemma)}`),
    // Phase 28. Grants: every call names the acting user (ADR 0008).
    listGrants: (actorUserId: string) => getJson<GrantList>('/api/grants', actorUserId),
    createGrant: (actorUserId: string, request: CreateGrantRequest) =>
      postJson<Grant>('/api/grants', request, { actorUserId }),
    acceptGrant: (actorUserId: string, grantId: string) =>
      postJson<Grant>(`/api/grants/${encodeURIComponent(grantId)}/accept`, {}, { actorUserId }),
    endGrant: (actorUserId: string, grantId: string) =>
      deleteResource(`/api/grants/${encodeURIComponent(grantId)}`, actorUserId),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
