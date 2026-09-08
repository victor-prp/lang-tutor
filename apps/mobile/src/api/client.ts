import type {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateUserRequest,
  LoginRequest,
  NextStepRequest,
  NextStepResponse,
  TranslationRequest,
  TranslationResponse,
  User,
} from '@lang-tutor/core/api';

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`API request failed with status ${status}`);
  }
}

export type ApiClientDeps = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
};

// `baseUrl` and `fetch` are received, not read from the environment or the
// global object. The literal process.env.EXPO_PUBLIC_API_URL now lives in
// app/_layout.tsx, which is where Metro's build-time inlining still sees it.
export function createApiClient({ baseUrl, fetch }: ApiClientDeps) {
  async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status);
    return (await res.json()) as TResponse;
  }

  return {
    // Identification, not authentication: there is no password to send.
    login: (request: LoginRequest) => postJson<User>('/api/login', request),
    createUser: (request: CreateUserRequest) => postJson<User>('/api/users', request),
    createSession: (request: CreateSessionRequest) =>
      postJson<CreateSessionResponse>('/api/sessions', request),
    nextStep: (sessionId: string, request: NextStepRequest) =>
      postJson<NextStepResponse>(`/api/sessions/${sessionId}/next-step`, request),
    translate: (request: TranslationRequest) =>
      postJson<TranslationResponse>('/api/translations', request),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
