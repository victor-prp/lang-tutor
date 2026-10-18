import type { ApiClient } from '@/api/client';

/**
 * Phase 52 (spec D4, D8). Practice reminders on this phone: the permission, the
 * push token the server sends to, the time zone the reminder hours are read in,
 * and a tapped reminder.
 *
 * The engine is expo-notifications, built in _layout.tsx (ADR 0002 R1). Reminders
 * reach the Android app only, and never Expo Go, where remote push does not exist
 * (SDK 53+): there `supported` is false and nothing here touches the engine. The
 * time zone is reported everywhere, because the learner's day follows it (ADR 0013).
 */
export type Permission = 'granted' | 'denied' | 'undetermined';

export type NotificationsEngine = {
  /** Creates the `reminders` channel. On Android 13+ the permission dialog needs one first. */
  setChannel(): Promise<void>;
  /** Reads the permission without asking. Android remembers a refusal as `denied`. */
  permission(): Promise<Permission>;
  /** Opens the system dialog, unless Android already refuses for the learner. */
  requestPermission(): Promise<Permission>;
  /** The Expo push token. Throws until the build carries a Firebase file. */
  token(): Promise<string>;
  /** Hears every tapped notification while the app runs, with its `reminder_id`. */
  onTap(listener: (reminderId: string | null) => void): () => void;
  /** The tap that launched the app from closed, cleared once read. */
  lastTap(): Promise<string | null>;
  /** This app's page in Android's settings, where a refusal is undone. */
  openSettings(): Promise<void>;
};

export type RemindersDeps = {
  engine: NotificationsEngine;
  api: Pick<ApiClient, 'registerPushDevice' | 'unregisterPushDevice' | 'setTimeZone' | 'tapReminder'>;
  /** Platform.OS. */
  platform: string;
  /** Constants.executionEnvironment === 'storeClient'. */
  isExpoGo: boolean;
  /** The device's IANA zone, e.g. `Asia/Jerusalem`. */
  timeZone: () => string;
  log: (event: string, detail: unknown) => void;
};

export function createReminders({ engine, api, platform, isExpoGo, timeZone, log }: RemindersDeps) {
  const supported = platform === 'android' && !isExpoGo;
  /** promptOnce asks once per launch; after that only the Reminders screen asks. */
  let asked = false;
  /** The token this launch registered, so sign-out need not fetch it again. */
  let knownToken: string | null = null;
  /** Read once per launch, however often onTap subscribes. */
  let lastTapRead: Promise<string | null> | null = null;
  /** The listener and the last response can both carry the tap that launched the app. */
  const tapped = new Set<string>();

  // A failure is logged and never thrown: a launch registers again, so one that
  // failed heals on the next. A token that cannot be fetched (no Firebase file
  // yet) leaves no registration, and reminders stay dormant.
  async function register(): Promise<void> {
    let token: string;
    try {
      token = await engine.token();
    } catch (error) {
      log('reminder_token_failed', error);
      return;
    }
    knownToken = token;
    try {
      await api.registerPushDevice(token);
    } catch (error) {
      log('reminder_register_failed', error);
    }
  }

  return {
    supported,

    async status(): Promise<Permission | 'unsupported'> {
      if (!supported) return 'unsupported';
      return engine.permission();
    },

    /** Home, once signed in: asks when undetermined, and registers once granted. Never throws. */
    async promptOnce(): Promise<void> {
      if (!supported) return;
      try {
        await engine.setChannel();
        let permission = await engine.permission();
        if (permission === 'undetermined' && !asked) {
          asked = true;
          permission = await engine.requestPermission();
        }
        if (permission === 'granted') await register();
      } catch (error) {
        log('reminder_prompt_failed', error);
      }
    },

    /**
     * The Reminders screen: asks unless granted, registers once granted, and
     * answers the permission. Throws only when the permission cannot be read or asked.
     */
    async enable(): Promise<Permission | 'unsupported'> {
      if (!supported) return 'unsupported';
      await engine.setChannel();
      let permission = await engine.permission();
      if (permission !== 'granted') {
        asked = true;
        permission = await engine.requestPermission();
      }
      if (permission === 'granted') await register();
      return permission;
    },

    /** Before sign-out clears the session, so the call still carries it. Never throws. */
    async unregister(): Promise<void> {
      if (!supported) return;
      try {
        const token = knownToken ?? (await engine.token());
        await api.unregisterPushDevice(token);
        knownToken = null;
      } catch (error) {
        log('reminder_unregister_failed', error);
      }
    },

    /**
     * Every platform, on every launch once signed in. Reports the device zone only
     * when the server does not already hold it: `known` is the zone it holds, or
     * null when that is not known. A launch that changed nothing sends nothing, so
     * there is no request for a page load to abort (spec D1). Never throws.
     */
    async reportTimeZone(known: string | null): Promise<void> {
      try {
        const zone = timeZone();
        if (zone === known) return;
        await api.setTimeZone(zone);
      } catch (error) {
        log('reminder_time_zone_failed', error);
      }
    },

    /**
     * Reports a tapped reminder, then calls `go`, without waiting on the report:
     * the session is marked by finishing it, not by the tap (spec D6). The tap
     * that launched the app is read from the last response, once per launch.
     */
    onTap(go: () => void): () => void {
      if (!supported) return () => {};
      let listening = true;
      const handle = (reminderId: string | null) => {
        if (!listening) return;
        if (reminderId !== null) {
          if (tapped.has(reminderId)) return;
          tapped.add(reminderId);
          api.tapReminder(reminderId).catch((error: unknown) => log('reminder_tap_failed', error));
        }
        // The app is open by now either way; only the session would not start.
        try {
          go();
        } catch (error) {
          log('reminder_open_failed', error);
        }
      };
      const stop = engine.onTap(handle);
      lastTapRead ??= engine.lastTap().catch((error: unknown) => {
        log('reminder_last_tap_failed', error);
        return null;
      });
      void lastTapRead.then((reminderId) => {
        if (reminderId !== null) handle(reminderId);
      });
      return () => {
        listening = false;
        stop();
      };
    },

    async openSettings(): Promise<void> {
      if (!supported) return;
      await engine.openSettings();
    },
  };
}

export type Reminders = ReturnType<typeof createReminders>;

/** Where a tapped reminder goes: בית, told to start the ready session. */
export type ReminderHref = { pathname: '/'; params: { start: 'reminder' } };

/** The part of expo-router's router a tapped reminder uses. */
export type ReminderRouter = {
  canDismiss: () => boolean;
  dismissTo: (href: ReminderHref) => void;
  navigate: (href: ReminderHref) => void;
};

/**
 * Phase 52 (spec D8), phase 64 (final review C1). A tapped reminder opens בית with
 * start=reminder, which LearningSection acts on. With a screen over the tabs (a session,
 * translate) the stack is dismissed to them, as phase 52 did: not a second home pushed over a
 * session. With a tab on top there is nothing to dismiss, and dismissTo's POP_TO is lost on the
 * tab navigator (its router has no such action), so the tap navigates, which jumps to בית and
 * sets the param.
 */
export function openReminderTap(router: ReminderRouter): void {
  const href: ReminderHref = { pathname: '/', params: { start: 'reminder' } };
  if (router.canDismiss()) router.dismissTo(href);
  else router.navigate(href);
}
