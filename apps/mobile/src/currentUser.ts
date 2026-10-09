export type RememberedEnrollmentStoreDeps = {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
};

const ENROLLMENT_KEY_PREFIX = 'lang-tutor:enrollment:';

/**
 * Remembers which enrollment each username last had active on this device —
 * the one piece of enrollment state that belongs to the device. Keyed per username so two learners sharing a phone never
 * inherit each other's language. The enrollment list itself is never stored:
 * it is a server fact, read fresh at every login.
 */
export function createRememberedEnrollmentStore({ storage }: RememberedEnrollmentStoreDeps) {
  return {
    read: (username: string): Promise<string | null> =>
      storage.getItem(`${ENROLLMENT_KEY_PREFIX}${username}`),
    write: async (username: string, enrollmentId: string): Promise<void> => {
      await storage.setItem(`${ENROLLMENT_KEY_PREFIX}${username}`, enrollmentId);
    },
  };
}

export type RememberedEnrollmentStore = ReturnType<typeof createRememberedEnrollmentStore>;
