/**
 * Phase 65 (spec D9). Whether to ask before "לתרגל עוד" when another session would add little
 * to readiness. The choice belongs to the device, per username, like the remembered enrollment
 * (currentUser.ts). A storage failure means "ask": it must never stand between a learner and
 * practice, and a missed write only asks once more.
 */
export type PracticeMoreAskStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

const STOPPED = 'stopped';
const ASKING = 'asking';

export function createPracticeMoreAskStore(storage: PracticeMoreAskStorage, prefix: string) {
  const write = async (username: string, value: string): Promise<void> => {
    try {
      await storage.setItem(`${prefix}${username}`, value);
    } catch {
      // Asking again is the safe default.
    }
  };
  return {
    shouldAsk: async (username: string): Promise<boolean> => {
      try {
        return (await storage.getItem(`${prefix}${username}`)) !== STOPPED;
      } catch {
        return true;
      }
    },
    stopAsking: (username: string): Promise<void> => write(username, STOPPED),
    askAgain: (username: string): Promise<void> => write(username, ASKING),
  };
}

export type PracticeMoreAskStore = ReturnType<typeof createPracticeMoreAskStore>;
