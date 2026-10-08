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
  JudgedAnswerRequest,
  JudgedAnswerResponse,
  MeResponse,
  NextStepRequest,
  NextStepResponse,
  PhotoImport,
  PhotoImportCreateRequest,
  PhotoImportItem,
  PhotoImportItemUpdate,
  PhotoImportSummary,
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

/** Phase 27 (spec D13). The server's own judge gives up after 8 s; past this the
 *  app does too, and the card offers "try again". */
export const JUDGE_REQUEST_TIMEOUT_MS = 15_000;
/** Phase 26. A photo is up to 2.8 MB, so it gets longer than a recording; past
 *  this the upload screen shows its upload-failed message and keeps the photo
 *  for a retry, instead of waiting with both buttons disabled. */
export const PHOTO_UPLOAD_TIMEOUT_MS = 60_000;

export type ApiClientDeps = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  /** Phase 29: the signed-in session as request headers (a Cookie on a phone, none on web). */
  sessionHeaders: () => Promise<Record<string, string>>;
  /** 'include' on web, where the browser keeps the cookie; 'omit' on a phone. */
  credentials: RequestCredentials;
  /** Told of every 401, before the call throws it. */
  onUnauthorized: () => void;
};

// Everything is received, not read from the environment or the global object.
// The literal process.env.EXPO_PUBLIC_API_URL lives in app/_layout.tsx, which
// is where Metro's build-time inlining still sees it. No call names its actor
// (spec D12): the session, sent by sessionHeaders, says who is asking.
export function createApiClient({ baseUrl, fetch, sessionHeaders, credentials, onUnauthorized }: ApiClientDeps) {
  async function send(
    method: string,
    path: string,
    init: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      credentials,
      headers: {
        ...(await sessionHeaders()),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (res.status === 401) onUnauthorized();
    if (!res.ok) throw await failureOf(res);
    return res;
  }

  async function postJson<TResponse>(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<TResponse> {
    const res = await send('POST', path, { body, ...(options.signal ? { signal: options.signal } : {}) });
    return (await res.json()) as TResponse;
  }

  async function patchJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const res = await send('PATCH', path, { body });
    return (await res.json()) as TResponse;
  }

  async function postNoContent(path: string): Promise<void> {
    await send('POST', path, { body: {} });
  }

  async function getJson<TResponse>(path: string): Promise<TResponse> {
    const res = await send('GET', path);
    return (await res.json()) as TResponse;
  }

  async function deleteResource(path: string): Promise<void> {
    await send('DELETE', path);
  }

  const vocabularyPath = (enrollmentId: string) =>
    `/api/enrollments/${encodeURIComponent(enrollmentId)}/vocabulary`;

  return {
    me: () => getJson<MeResponse>('/api/me'),
    createProfile: (request: CreateUserRequest) => postJson<User>('/api/users', request),
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
    judgeAnswer: async (sessionId: string, request: JudgedAnswerRequest) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JUDGE_REQUEST_TIMEOUT_MS);
      try {
        return await postJson<JudgedAnswerResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/judged-answer`,
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
    // Phase 29 (spec D12): the signed-in learner's own; the server knows who.
    listEnrollments: () => getJson<Enrollment[]>('/api/enrollments'),
    createEnrollment: (request: CreateEnrollmentRequest) => postJson<Enrollment>('/api/enrollments', request),
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
    // Phase 28. Grants, as the signed-in user (phase 29: the session says who).
    listGrants: () => getJson<GrantList>('/api/grants'),
    createGrant: (request: CreateGrantRequest) => postJson<Grant>('/api/grants', request),
    acceptGrant: (grantId: string) => postJson<Grant>(`/api/grants/${encodeURIComponent(grantId)}/accept`, {}),
    endGrant: (grantId: string) => deleteResource(`/api/grants/${encodeURIComponent(grantId)}`),

    // Phase 26. Words from a photo.
    createPhotoImport: async (enrollmentId: string, request: PhotoImportCreateRequest) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PHOTO_UPLOAD_TIMEOUT_MS);
      try {
        return await postJson<PhotoImportSummary>(
          `/api/enrollments/${encodeURIComponent(enrollmentId)}/photo-imports`,
          request,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }
    },
    listPhotoImports: (enrollmentId: string) =>
      getJson<PhotoImportSummary[]>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/photo-imports`),
    getPhotoImport: (id: string) => getJson<PhotoImport>(`/api/photo-imports/${encodeURIComponent(id)}`),
    updatePhotoImportItem: (id: string, position: number, update: PhotoImportItemUpdate) =>
      patchJson<PhotoImportItem>(`/api/photo-imports/${encodeURIComponent(id)}/items/${position}`, update),
    savePhotoImport: (id: string) =>
      postJson<SaveVocabularyResponse>(`/api/photo-imports/${encodeURIComponent(id)}/save`, {}),
    discardPhotoImport: (id: string) => postNoContent(`/api/photo-imports/${encodeURIComponent(id)}/discard`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
