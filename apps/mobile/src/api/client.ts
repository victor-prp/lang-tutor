import type {
  AddTargetWordsRequest,
  ChangeTargetDateRequest,
  CreateEnrollmentRequest,
  CreateGrantRequest,
  CreateQuestionTypeSessionRequest,
  CreateQuestionTypeSessionResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateTargetRequest,
  CreateUserRequest,
  CurrentSessionResponse,
  Enrollment,
  Grant,
  GrantList,
  HealthResponse,
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
  PushDeviceRequest,
  PushDeviceUnregisterRequest,
  QuestionTypesResponse,
  ReminderSettings,
  ReminderSettingsResponse,
  SaveVocabularyRequest,
  SaveVocabularyResponse,
  RemoveVocabularyWordsResponse,
  SessionView,
  SkipSessionResponse,
  StartSessionRequest,
  StartSessionResponse,
  SpeechAnswerRequest,
  SpeechAnswerResponse,
  Target,
  TargetList,
  TimeZoneRequest,
  TranslationRequest,
  TranslationResponse,
  User,
  VocabularyPage,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';

export class ApiError extends Error {
  // `code` is the body's `error` string when there is one: the server answers
  // several 409s (session_open, no_saved_words, …) that the status alone
  // cannot tell apart. Phase 53: `reason` is the body's `reason` beside it, which
  // says why an `invalid target` was refused (no_words, due_date, unknown_import).
  constructor(
    public readonly status: number,
    public readonly code?: string,
    public readonly reason?: string,
  ) {
    super(`API request failed with status ${status}${code ? ` (${code}${reason ? `: ${reason}` : ''})` : ''}`);
  }
}

async function failureOf(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown; reason?: unknown };
    return new ApiError(
      res.status,
      typeof body.error === 'string' ? body.error : undefined,
      typeof body.reason === 'string' ? body.reason : undefined,
    );
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

/** Phase 49 (review I1). React Native sets no timeout of its own; past this the
 *  About screen's Server line reads "not reachable" instead of waiting forever. */
export const HEALTH_TIMEOUT_MS = 5_000;

export type ApiClientDeps = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  /** Phase 29: the signed-in session as request headers (a Cookie on a phone, none on web). */
  sessionHeaders: () => Promise<Record<string, string>>;
  /** 'include' on web, where the browser keeps the cookie; 'omit' on a phone. */
  credentials: RequestCredentials;
  /** Told of every 401, before the call throws it. */
  onUnauthorized: () => void;
  /** Phase 32 (spec D9): sent on every call. The API level on a phone, none on web. */
  appHeaders: Record<string, string>;
  /** Told of every 426, the server's "this app is too old", before the call throws it. */
  onUpdateRequired: () => void;
};

// Everything is received, not read from the environment or the global object.
// The literal process.env.EXPO_PUBLIC_API_URL lives in app/_layout.tsx, which
// is where Metro's build-time inlining still sees it. No call names its actor
// (spec D12): the session, sent by sessionHeaders, says who is asking.
export function createApiClient({
  baseUrl,
  fetch,
  sessionHeaders,
  credentials,
  onUnauthorized,
  appHeaders,
  onUpdateRequired,
}: ApiClientDeps) {
  async function send(
    method: string,
    path: string,
    init: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      credentials,
      headers: {
        ...appHeaders,
        ...(await sessionHeaders()),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (res.status === 401) onUnauthorized();
    if (res.status === 426) onUpdateRequired();
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

  async function putJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const res = await send('PUT', path, { body });
    return (await res.json()) as TResponse;
  }

  async function postNoContent(path: string, body: unknown): Promise<void> {
    await send('POST', path, { body });
  }

  async function putNoContent(path: string, body: unknown): Promise<void> {
    await send('PUT', path, { body });
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
  const targetsPath = (enrollmentId: string) => `/api/enrollments/${encodeURIComponent(enrollmentId)}/targets`;
  const targetPath = (targetId: string) => `/api/targets/${encodeURIComponent(targetId)}`;

  return {
    /** Phase 49 (spec D1). The server's own release, for the About screen. */
    health: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      try {
        const res = await send('GET', '/health', { signal: controller.signal });
        return (await res.json()) as HealthResponse;
      } finally {
        clearTimeout(timer);
      }
    },
    me: () => getJson<MeResponse>('/api/me'),
    createProfile: (request: CreateUserRequest) => postJson<User>('/api/users', request),
    createSession: (request: CreateSessionRequest) =>
      postJson<CreateSessionResponse>('/api/sessions', request),
    nextStep: async (sessionId: string, request: NextStepRequest) => {
      // Phase 41 (review I1). A fit check waits on the server's model call, so it
      // is given up as a judged answer is, and the card offers "try again".
      if (!('check_fit' in request && request.check_fit)) {
        return postJson<NextStepResponse>(`/api/sessions/${sessionId}/next-step`, request);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JUDGE_REQUEST_TIMEOUT_MS);
      try {
        return await postJson<NextStepResponse>(`/api/sessions/${sessionId}/next-step`, request, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
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
    // Phase 61 (spec D2, D3). A tester's read of one saved meaning's question types, and its session.
    questionTypes: (enrollmentId: string, query: { glossId: string; variantId: string; listening: boolean; speaking: boolean }) => {
      const params = new URLSearchParams({
        gloss_id: query.glossId,
        variant_id: query.variantId,
        listening: String(query.listening),
        speaking: String(query.speaking),
      });
      return getJson<QuestionTypesResponse>(`${vocabularyPath(enrollmentId)}/question-types?${params}`);
    },
    createQuestionTypeSession: (enrollmentId: string, request: CreateQuestionTypeSessionRequest) =>
      postJson<CreateQuestionTypeSessionResponse>(
        `/api/enrollments/${encodeURIComponent(enrollmentId)}/question-type-sessions`,
        request,
      ),
    skipSession: (sessionId: string) =>
      postJson<SkipSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/skip`, {}),
    // Phase 43 (spec D2). Starting a session has the next one built for this device.
    startSession: (sessionId: string, request: StartSessionRequest) =>
      postJson<StartSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/start`, request),
    currentSession: (enrollmentId: string) =>
      getJson<CurrentSessionResponse>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/sessions/current`),
    translate: (request: TranslationRequest) =>
      postJson<TranslationResponse>('/api/translations', request),
    // Phase 29 (spec D12): the signed-in learner's own; the server knows who.
    listEnrollments: () => getJson<Enrollment[]>('/api/enrollments'),
    createEnrollment: (request: CreateEnrollmentRequest) => postJson<Enrollment>('/api/enrollments', request),
    saveVocabulary: (enrollmentId: string, request: SaveVocabularyRequest) =>
      postJson<SaveVocabularyResponse>(vocabularyPath(enrollmentId), request),
    unsaveVocabulary: (enrollmentId: string, glossId: string) =>
      deleteResource(`${vocabularyPath(enrollmentId)}/glosses/${encodeURIComponent(glossId)}`),
    // Phase 58 (spec D2). Every word at the level, every saved sense of it; 58b (R2):
    // or every word of the list, which the server takes only as an explicit all=true.
    removeVocabularyWords: async (enrollmentId: string, scope: { level: number } | { all: true }) => {
      const query = 'all' in scope ? 'all=true' : `level=${scope.level}`;
      const res = await send('DELETE', `${vocabularyPath(enrollmentId)}?${query}`);
      return (await res.json()) as RemoveVocabularyWordsResponse;
    },
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
    // Phase 64 (final review I2). The photo flow's My words: its imports, saved as a prep saves them.
    savePhotoImports: (enrollmentId: string, importIds: string[]) =>
      postJson<SaveVocabularyResponse>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/photo-imports/save`, {
        photo_import_ids: importIds,
      }),
    discardPhotoImport: (id: string) => postNoContent(`/api/photo-imports/${encodeURIComponent(id)}/discard`, {}),

    // Phase 52 (spec D1, D2, D4, D6). Practice reminders: the schedule, the zone its
    // hours are read in, this phone's push token, and a tapped reminder.
    reminderSettings: () => getJson<ReminderSettingsResponse>('/api/me/reminders'),
    putReminderSettings: (settings: ReminderSettings) =>
      putJson<ReminderSettingsResponse>('/api/me/reminders', settings),
    setTimeZone: (timeZone: string) =>
      putNoContent('/api/me/time-zone', { time_zone: timeZone } satisfies TimeZoneRequest),
    registerPushDevice: (token: string) =>
      putNoContent('/api/me/push-devices', { token, platform: 'android' } satisfies PushDeviceRequest),
    unregisterPushDevice: (token: string) =>
      postNoContent('/api/me/push-devices/unregister', { token } satisfies PushDeviceUnregisterRequest),
    tapReminder: (id: string) => postNoContent(`/api/me/reminders/${encodeURIComponent(id)}/tap`, {}),

    // Phase 53 (spec D13). Preparing for homework or a test: the enrollment's active
    // targets and a new one, then one target, its words, its date, and its end.
    listTargets: (enrollmentId: string) => getJson<TargetList>(targetsPath(enrollmentId)),
    getTarget: (targetId: string) => getJson<Target>(targetPath(targetId)),
    createTarget: (enrollmentId: string, request: CreateTargetRequest) =>
      postJson<Target>(targetsPath(enrollmentId), request),
    addTargetWords: (targetId: string, request: AddTargetWordsRequest) =>
      postJson<Target>(`${targetPath(targetId)}/words`, request),
    removeTargetWord: (targetId: string, glossId: string) =>
      deleteResource(`${targetPath(targetId)}/words/${encodeURIComponent(glossId)}`),
    changeTargetDate: (targetId: string, request: ChangeTargetDateRequest) =>
      patchJson<Target>(targetPath(targetId), request),
    endTarget: (targetId: string) => postNoContent(`${targetPath(targetId)}/end`, {}),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
