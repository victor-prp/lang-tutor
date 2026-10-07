import type {
  CreateEnrollmentRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateUserRequest,
  CurrentSessionResponse,
  Enrollment,
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

export type ApiClientDeps = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
};

// `baseUrl` and `fetch` are received, not read from the environment or the
// global object. The literal process.env.EXPO_PUBLIC_API_URL now lives in
// app/_layout.tsx, which is where Metro's build-time inlining still sees it.
export function createApiClient({ baseUrl, fetch }: ApiClientDeps) {
  async function postJson<TResponse>(path: string, body: unknown, signal?: AbortSignal): Promise<TResponse> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw await failureOf(res);
    return (await res.json()) as TResponse;
  }

  async function getJson<TResponse>(path: string): Promise<TResponse> {
    const res = await fetch(`${baseUrl}${path}`, { method: 'GET' });
    if (!res.ok) throw await failureOf(res);
    return (await res.json()) as TResponse;
  }

  async function deleteResource(path: string): Promise<void> {
    const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
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
          controller.signal,
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
    saveVocabulary: (enrollmentId: string, request: SaveVocabularyRequest) =>
      postJson<SaveVocabularyResponse>(vocabularyPath(enrollmentId), request),
    unsaveVocabulary: (enrollmentId: string, senseId: string) =>
      deleteResource(`${vocabularyPath(enrollmentId)}/senses/${encodeURIComponent(senseId)}`),
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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
