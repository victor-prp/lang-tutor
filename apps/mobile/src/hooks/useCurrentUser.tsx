import type { CreateUserRequest, Enrollment, LanguageCode, User } from '@lang-tutor/core/api';
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
import type { RememberedEnrollmentStore, RememberedUsernameStore } from '@/currentUser';
import { chooseActive } from '@/enrollments';

export type CurrentUserValue = {
  /** The identified learner, in memory only. Null between app launch and login. */
  user: User | null;
  /** Every enrollment the learner has. Empty until login, and for a learner who has not enrolled yet. */
  enrollments: Enrollment[];
  /** The enrollment the learner is studying now, or null when they have none. */
  active: Enrollment | null;
  /** Prefill for the login field. Arrives asynchronously; '' until it does. */
  rememberedUsername: string;
  login: (username: string) => Promise<void>;
  register: (input: CreateUserRequest) => Promise<void>;
  signOut: () => void;
  enroll: (target: LanguageCode) => Promise<void>;
  switchTo: (enrollmentId: string) => void;
};

const CurrentUserContext = createContext<CurrentUserValue | null>(null);

export function CurrentUserProvider({
  api,
  usernameStore,
  enrollmentStore,
  children,
}: {
  api: ApiClient;
  usernameStore: RememberedUsernameStore;
  enrollmentStore: RememberedEnrollmentStore;
  children: ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rememberedUsername, setRememberedUsername] = useState('');

  useEffect(() => {
    void usernameStore.read().then(setRememberedUsername);
  }, [usernameStore]);

  // The profile lives in memory; only the username is written to storage. Both
  // login and register end here, so there is one place that decides what being
  // logged in means.
  //
  // The user is set LAST, after the enrollments are in: every screen routes on
  // `user` first, so setting it early would flash home before the enroll
  // screen for a learner with none.
  const adopt = useCallback(
    async (next: User, list: Enrollment[], rememberedId: string | null) => {
      setEnrollments(list);
      setActiveId(chooseActive(list, rememberedId)?.id ?? null);
      setUser(next);
      setRememberedUsername(next.username);
      await usernameStore.write(next.username);
    },
    [usernameStore],
  );

  const login = useCallback(
    async (username: string) => {
      const next = await api.login({ username });
      const [list, rememberedId] = await Promise.all([
        api.listEnrollments(next.id),
        enrollmentStore.read(next.username),
      ]);
      await adopt(next, list, rememberedId);
    },
    [api, enrollmentStore, adopt],
  );

  // A user createUser just returned has no enrollments by definition, so there
  // is nothing to fetch. Fetching anyway would let a failed list call leave the
  // account created but the learner on the form, where a retry is a 409
  // "username taken" rather than a hint to log in.
  const register = useCallback(
    async (input: CreateUserRequest) => {
      await adopt(await api.createUser(input), [], null);
    },
    [api, adopt],
  );

  // Keeps the remembered username on purpose: the login field stays prefilled,
  // which is the entire reason it is remembered.
  const signOut = useCallback(() => {
    setUser(null);
    setEnrollments([]);
    setActiveId(null);
  }, []);

  // A 409 means the enrollment already exists — a double tap, or another
  // device — which is the outcome the learner asked for, so it is adopted
  // rather than shown as a failure.
  const enroll = useCallback(
    async (target: LanguageCode) => {
      if (!user) throw new Error('cannot enroll with no current user');
      let created: Enrollment | undefined;
      try {
        created = await api.createEnrollment(user.id, { source_language: 'he', target_language: target });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      }
      const list = await api.listEnrollments(user.id);
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
      if (user) void enrollmentStore.write(user.username, enrollmentId);
    },
    [user, enrollmentStore],
  );

  const active = useMemo(
    () => enrollments.find((enrollment) => enrollment.id === activeId) ?? null,
    [enrollments, activeId],
  );

  const value = useMemo(
    () => ({ user, enrollments, active, rememberedUsername, login, register, signOut, enroll, switchTo }),
    [user, enrollments, active, rememberedUsername, login, register, signOut, enroll, switchTo],
  );

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserValue {
  const value = useContext(CurrentUserContext);
  if (!value) throw new Error('useCurrentUser must be used inside a CurrentUserProvider');
  return value;
}
