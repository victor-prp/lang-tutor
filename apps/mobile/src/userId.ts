const STORAGE_KEY = 'lang-tutor:user-id';

export type UserIdStoreDeps = {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
  randomUUID: () => string;
};

// A client-generated placeholder — no auth exists yet. Persisted so the same
// install keeps the same id across app restarts. Storage and the id generator
// are received rather than imported, which is why this file no longer needs
// jest.mock to be testable.
export function createUserIdStore({ storage, randomUUID }: UserIdStoreDeps) {
  return {
    getOrCreateUserId: async (): Promise<string> => {
      const existing = await storage.getItem(STORAGE_KEY);
      if (existing) return existing;
      const created = randomUUID();
      await storage.setItem(STORAGE_KEY, created);
      return created;
    },
  };
}

export type UserIdStore = ReturnType<typeof createUserIdStore>;
