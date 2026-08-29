import type {
  CreateSessionRequest,
  CreateSessionResponse,
  NextStepRequest,
  NextStepResponse,
} from '@lang-tutor/core/api';

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`API request failed with status ${status}`);
  }
}

async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
  // Read directly off process.env.EXPO_PUBLIC_API_URL (not via an
  // indirection) so Metro's build-time inlining for EXPO_PUBLIC_* variables
  // recognizes and replaces it in the real app bundle.
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is not set');
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ApiError(res.status);
  }
  return (await res.json()) as TResponse;
}

export function createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
  return postJson<CreateSessionResponse>('/api/sessions', request);
}

export function nextStep(sessionId: string, request: NextStepRequest): Promise<NextStepResponse> {
  return postJson<NextStepResponse>(`/api/sessions/${sessionId}/next-step`, request);
}
