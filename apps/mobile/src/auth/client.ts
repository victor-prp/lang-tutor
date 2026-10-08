import { expoClient } from '@better-auth/expo/client';
import { emailOTPClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { AuthError } from '@/signIn';

/** The four expo-secure-store functions Better Auth's Expo client uses (its ExpoClientStorage). */
export type SecureStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

/**
 * Phase 29 (spec D18, ADR 0009 R1). The ONE app file that imports better-auth.
 * Built in _layout.tsx with SecureStore and passed down. On the phone the
 * session cookie lives in SecureStore and our API calls carry it as a Cookie
 * header (sessionHeaders); on web the browser keeps it and fetch sends it
 * with credentials: 'include'.
 */
export function createAppAuthClient({
  baseUrl,
  platform,
  storage,
}: {
  baseUrl: string;
  platform: string;
  storage: SecureStorage;
}) {
  const web = platform === 'web';
  const client = createAuthClient({
    baseURL: baseUrl,
    basePath: '/api/auth',
    fetchOptions: web ? { credentials: 'include' } : undefined,
    plugins: [expoClient({ scheme: 'langtutor', storagePrefix: 'langtutor', storage }), emailOTPClient()],
  });

  const fail = (error: { status: number; code?: string } | null | undefined): void => {
    if (error) throw new AuthError(error.status, error.code);
  };

  return {
    sendCode: async (email: string): Promise<void> => {
      const result = await client.emailOtp.sendVerificationOtp({ email: email.trim().toLowerCase(), type: 'sign-in' });
      fail(result.error);
    },
    signIn: async (email: string, code: string): Promise<void> => {
      const result = await client.signIn.emailOtp({ email: email.trim().toLowerCase(), otp: code });
      fail(result.error);
    },
    signOut: async (): Promise<void> => {
      await client.signOut();
    },
    /**
     * Ruling 4 (spec D6). Better Auth slides a session, and re-issues its
     * cookie, only in get-session; our API calls are plain fetches whose
     * Set-Cookie would never reach SecureStore. So start-up calls this before
     * api.me(). Offline must not throw.
     */
    refresh: async (): Promise<void> => {
      try {
        await client.getSession();
      } catch {
        // Offline or failed: the session simply does not slide this time.
      }
    },
    /** The spike's Android fix: getCookie() is async; an un-awaited one crashes the request. */
    sessionHeaders: async (): Promise<Record<string, string>> => {
      if (web) return {};
      const cookie = await client.getCookie();
      return cookie ? { cookie } : {};
    },
    credentials: (web ? 'include' : 'omit') as RequestCredentials,
  };
}

export type AppAuthClient = ReturnType<typeof createAppAuthClient>;
