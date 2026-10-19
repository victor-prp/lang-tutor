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

/**
 * Phase 65 (spec D9), final review I3. The הגדרות switch: `read` shows the stored choice (each time
 * the screen is shown: the sheet's tick box can change it while the tab stays mounted), and
 * returns a stop for a read the screen no longer waits for; `flip` shows the learner's choice at
 * once and stores it. A read that resolves after a flip is ignored: the flip is newer.
 */
export function createAskSwitch(
  store: Pick<PracticeMoreAskStore, 'shouldAsk' | 'stopAsking' | 'askAgain'>,
  username: string,
  show: (ask: boolean) => void,
) {
  let flips = 0;
  return {
    read: (): (() => void) => {
      const seen = flips;
      let live = true;
      void store.shouldAsk(username).then((ask) => {
        if (live && flips === seen) show(ask);
      });
      return () => {
        live = false;
      };
    },
    flip: (ask: boolean): void => {
      flips += 1;
      show(ask);
      void (ask ? store.askAgain(username) : store.stopAsking(username));
    },
  };
}
