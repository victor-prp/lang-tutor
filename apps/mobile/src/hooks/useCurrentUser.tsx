import type { CreateUserRequest, Enrollment, Grant, GrantList, LanguageCode, User } from '@lang-tutor/core/api';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiError, type ApiClient } from '@/api/client';
import type { AppAuthClient } from '@/auth/client';
import type { AuthEvents } from '@/authEvents';
import type { RememberedEnrollmentStore } from '@/currentUser';
import { chooseActive } from '@/enrollments';
import { NO_GRANTS, normalizeUsername } from '@/grants';
import { cleanCode } from '@/signIn';
import { startStateOf, startUp, type StartState } from '@/startState';

export type CurrentUserValue = {
  /** Phase 29 (spec D19). Where start-up and sign-in have got to. */
  status: StartState;
  /** The signed-in account's email, once /api/me has answered. */
  email: string | null;
  /** The learner's profile, in memory only. Null until signed in with a profile. */
  user: User | null;
  /** Every enrollment the learner has. Empty until sign-in, and for a learner who has not enrolled yet. */
  enrollments: Enrollment[];
  /** The enrollment the learner is studying now, or null when they have none. */
  active: Enrollment | null;
  /** Asks /api/me again, e.g. from the offline screen. */
  retry: () => Promise<void>;
  /** Emails a code. Throws AuthError; the screen maps it. */
  sendCode: (email: string) => Promise<void>;
  signIn: (email: string, code: string) => Promise<void>;
  createProfile: (input: CreateUserRequest) => Promise<void>;
  /** The server may be unreachable; the device forgets regardless. */
  signOut: () => Promise<void>;
  enroll: (target: LanguageCode) => Promise<void>;
  switchTo: (enrollmentId: string) => void;
  /** Phase 28. Grants on this account's lists and grants it holds. NO_GRANTS until sign-in. */
  grants: GrantList;
  /** Re-reads grants; a failed read keeps the last list (spec D15). */
  reloadGrants: () => Promise<void>;
  /** The current user invites a student; grants are re-read on success. Throws the ApiError. */
  invite: (username: string, target: LanguageCode) => Promise<Grant>;
  acceptInvite: (grantId: string) => Promise<void>;
  endGrant: (grantId: string) => Promise<void>;
};

const CurrentUserContext = createContext<CurrentUserValue | null>(null);

export function CurrentUserProvider({
  api,
  auth,
  authEvents,
  enrollmentStore,
  children,
}: {
  api: ApiClient;
  auth: AppAuthClient;
  authEvents: AuthEvents;
  enrollmentStore: RememberedEnrollmentStore;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<StartState>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [grants, setGrants] = useState<GrantList>(NO_GRANTS);
  const [activeId, setActiveId] = useState<string | null>(null);

  // The profile lives in memory; the session lives in the auth client's
  // storage. Start-up and onboarding both end here, so there is one place that
  // decides what being signed in means.
  //
  // The user is set LAST, after the enrollments are in: every screen routes on
  // `user` first, so setting it early would flash home before the enroll
  // screen for a learner with none.
  const adopt = useCallback(
    (next: User, list: Enrollment[], rememberedId: string | null, grantList: GrantList) => {
      setEnrollments(list);
      setGrants(grantList);
      setActiveId(chooseActive(list, rememberedId)?.id ?? null);
      setUser(next);
      setStatus('signed_in');
    },
    [],
  );

  const clear = useCallback((next: StartState) => {
    setUser(null);
    setEmail(null);
    setEnrollments([]);
    setGrants(NO_GRANTS);
    setActiveId(null);
    setStatus(next);
  }, []);

  // refresh() before me() slides the cookie (spec D6); see startUp.
  const start = useCallback(async () => {
    const { state, me } = await startUp({ refresh: auth.refresh, me: api.me });
    if (!me) {
      if (state === 'signed_out') clear('signed_out');
      else setStatus(state);
      return;
    }
    setEmail(me.email);
    if (!me.user) {
      setStatus('needs_profile');
      return;
    }
    try {
      const [list, grantList, rememberedId] = await Promise.all([
        api.listEnrollments(),
        api.listGrants(),
        enrollmentStore.read(me.user.username),
      ]);
      adopt(me.user, list, rememberedId, grantList);
    } catch (error) {
      const next = startStateOf({ kind: 'error', error });
      if (next === 'signed_out') clear('signed_out');
      else setStatus(next);
    }
  }, [api, auth, enrollmentStore, adopt, clear]);

  const retry = useCallback(async () => {
    setStatus('loading');
    await start();
  }, [start]);

  useEffect(() => {
    void start();
    // Once on mount; later runs go through retry and signIn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A 401 at any time returns to sign-in (spec D19).
  useEffect(() => authEvents.onUnauthorized(() => clear('signed_out')), [authEvents, clear]);

  const sendCode = useCallback((address: string) => auth.sendCode(address), [auth]);

  const signIn = useCallback(
    async (address: string, code: string) => {
      await auth.signIn(address, cleanCode(code));
      await start();
    },
    [auth, start],
  );

  // A profile createProfile just returned has no enrollments by definition, so
  // there is nothing to fetch. Fetching anyway would let a failed list call
  // leave the profile created but the learner on the form.
  const createProfile = useCallback(
    async (input: CreateUserRequest) => {
      adopt(await api.createProfile(input), [], null, NO_GRANTS);
    },
    [api, adopt],
  );

  const signOut = useCallback(async () => {
    await auth.signOut().catch(() => {});
    clear('signed_out');
  }, [auth, clear]);

  // A 409 means the enrollment already exists — a double tap, or another
  // device — which is the outcome the learner asked for, so it is adopted
  // rather than shown as a failure.
  const enroll = useCallback(
    async (target: LanguageCode) => {
      if (!user) throw new Error('cannot enroll with no current user');
      let created: Enrollment | undefined;
      try {
        created = await api.createEnrollment({ source_language: 'he', target_language: target });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      }
      const list = await api.listEnrollments();
      const chosen = created ?? list.find((enrollment) => enrollment.target_language === target) ?? null;
      setEnrollments(list);
      if (chosen) {
        setActiveId(chosen.id);
        await enrollmentStore.write(user.username, chosen.id);
      }
    },
    [api, user, enrollmentStore],
  );

  const switchTo = useCallback(
    (enrollmentId: string) => {
      setActiveId(enrollmentId);
      // The switch has already happened; failing to remember it only costs
      // the choice at the next launch, so a storage failure is swallowed
      // rather than left as an unhandled rejection.
      if (user) enrollmentStore.write(user.username, enrollmentId).catch(() => {});
    },
    [user, enrollmentStore],
  );

  const reloadGrants = useCallback(async () => {
    if (!user) return;
    try {
      setGrants(await api.listGrants());
    } catch {
      // Keep the last list: a failed read must not empty the screens (spec D15).
    }
  }, [api, user]);

  const invite = useCallback(
    async (username: string, target: LanguageCode) => {
      if (!user) throw new Error('cannot invite with no current user');
      const created = await api.createGrant({
        username: normalizeUsername(username),
        target_language: target,
      });
      await reloadGrants();
      return created;
    },
    [api, user, reloadGrants],
  );

  const acceptInvite = useCallback(
    async (grantId: string) => {
      if (!user) throw new Error('cannot accept an invite with no current user');
      await api.acceptGrant(grantId);
      await reloadGrants();
    },
    [api, user, reloadGrants],
  );

  const endGrant = useCallback(
    async (grantId: string) => {
      if (!user) throw new Error('cannot end a grant with no current user');
      await api.endGrant(grantId);
      await reloadGrants();
    },
    [api, user, reloadGrants],
  );

  const active = useMemo(
    () => enrollments.find((enrollment) => enrollment.id === activeId) ?? null,
    [enrollments, activeId],
  );

  const value = useMemo(
    () => ({
      status,
      email,
      user,
      enrollments,
      active,
      retry,
      sendCode,
      signIn,
      createProfile,
      signOut,
      enroll,
      switchTo,
      grants,
      reloadGrants,
      invite,
      acceptInvite,
      endGrant,
    }),
    [
      status,
      email,
      user,
      enrollments,
      active,
      retry,
      sendCode,
      signIn,
      createProfile,
      signOut,
      enroll,
      switchTo,
      grants,
      reloadGrants,
      invite,
      acceptInvite,
      endGrant,
    ],
  );

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserValue {
  const value = useContext(CurrentUserContext);
  if (!value) throw new Error('useCurrentUser must be used inside a CurrentUserProvider');
  return value;
}
