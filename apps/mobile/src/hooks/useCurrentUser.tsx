import type { CreateUserRequest, User } from '@lang-tutor/core/api';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { ApiClient } from '@/api/client';
import type { RememberedUsernameStore } from '@/currentUser';

export type CurrentUserValue = {
  /** The identified learner, in memory only. Null between app launch and login. */
  user: User | null;
  /** Prefill for the login field. Arrives asynchronously; '' until it does. */
  rememberedUsername: string;
  login: (username: string) => Promise<void>;
  register: (input: CreateUserRequest) => Promise<void>;
  signOut: () => void;
};

const CurrentUserContext = createContext<CurrentUserValue | null>(null);

export function CurrentUserProvider({
  api,
  usernameStore,
  children,
}: {
  api: ApiClient;
  usernameStore: RememberedUsernameStore;
  children: ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [rememberedUsername, setRememberedUsername] = useState('');

  useEffect(() => {
    void usernameStore.read().then(setRememberedUsername);
  }, [usernameStore]);

  // The profile lives in memory; only the username is written to storage. Both
  // login and register end here, so there is one place that decides what being
  // logged in means.
  const adopt = useCallback(
    async (next: User) => {
      setUser(next);
      setRememberedUsername(next.username);
      await usernameStore.write(next.username);
    },
    [usernameStore],
  );

  const login = useCallback(
    async (username: string) => {
      await adopt(await api.login({ username }));
    },
    [api, adopt],
  );

  const register = useCallback(
    async (input: CreateUserRequest) => {
      await adopt(await api.createUser(input));
    },
    [api, adopt],
  );

  // Keeps the remembered username on purpose: the login field stays prefilled,
  // which is the entire reason it is remembered.
  const signOut = useCallback(() => setUser(null), []);

  const value = useMemo(
    () => ({ user, rememberedUsername, login, register, signOut }),
    [user, rememberedUsername, login, register, signOut],
  );

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserValue {
  const value = useContext(CurrentUserContext);
  if (!value) throw new Error('useCurrentUser must be used inside a CurrentUserProvider');
  return value;
}
