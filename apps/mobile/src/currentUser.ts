const STORAGE_KEY = 'lang-tutor:username';

export type RememberedUsernameStoreDeps = {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
};

/**
 * Remembers the last username typed into the login screen — nothing else.
 *
 * The profile is deliberately not cached: it is a server fact, and a copy here
 * would go stale the moment anything changed it. The username is the one part
 * of identity that belongs to this device.
 *
 * There is no clear(): signing out keeps the username so the field stays
 * prefilled, which is the point of remembering it at all.
 */
export function createRememberedUsernameStore({ storage }: RememberedUsernameStoreDeps) {
  return {
    // '' rather than null: the only consumer is a TextInput's value.
    read: async (): Promise<string> => (await storage.getItem(STORAGE_KEY)) ?? '',
    write: async (username: string): Promise<void> => {
      await storage.setItem(STORAGE_KEY, username);
    },
  };
}

export type RememberedUsernameStore = ReturnType<typeof createRememberedUsernameStore>;
