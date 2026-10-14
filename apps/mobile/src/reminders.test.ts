import { describe, expect, it } from '@jest/globals';

import { createReminders, type NotificationsEngine, type Permission, type RemindersDeps } from './reminders';

const TOKEN = 'ExponentPushToken[abc]';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Over = {
  permission?: Permission;
  /** What the permission dialog answers. */
  answer?: Permission;
  tokenFails?: boolean;
  permissionFails?: boolean;
  lastTap?: string | null;
  apiFails?: boolean;
};

// A recording engine and api, writing to one list, so the order across the two is visible.
function setup(over: Over = {}, where: { platform?: string; isExpoGo?: boolean } = {}) {
  const calls: string[] = [];
  const logged: { event: string; detail: unknown }[] = [];
  let permission: Permission = over.permission ?? 'undetermined';
  const tapListeners = new Set<(reminderId: string | null) => void>();

  const engine: NotificationsEngine = {
    setChannel: async () => {
      calls.push('setChannel');
    },
    permission: async () => {
      calls.push('permission');
      if (over.permissionFails) throw new Error('no activity');
      return permission;
    },
    requestPermission: async () => {
      calls.push('requestPermission');
      permission = over.answer ?? 'granted';
      return permission;
    },
    token: async () => {
      calls.push('token');
      if (over.tokenFails) throw new Error('no google-services.json');
      return TOKEN;
    },
    onTap: (listener) => {
      calls.push('onTap');
      tapListeners.add(listener);
      return () => {
        tapListeners.delete(listener);
      };
    },
    lastTap: async () => {
      calls.push('lastTap');
      return over.lastTap ?? null;
    },
    openSettings: async () => {
      calls.push('openSettings');
    },
  };

  const failing = async (call: string) => {
    calls.push(call);
    if (over.apiFails) throw new Error('offline');
  };
  const api: RemindersDeps['api'] = {
    registerPushDevice: (token) => failing(`registerPushDevice ${token}`),
    unregisterPushDevice: (token) => failing(`unregisterPushDevice ${token}`),
    setTimeZone: (timeZone) => failing(`setTimeZone ${timeZone}`),
    tapReminder: (id) => failing(`tapReminder ${id}`),
  };

  const reminders = createReminders({
    engine,
    api,
    platform: where.platform ?? 'android',
    isExpoGo: where.isExpoGo ?? false,
    timeZone: () => 'Asia/Jerusalem',
    log: (event, detail) => logged.push({ event, detail }),
  });
  const tap = (reminderId: string | null) => {
    for (const listener of [...tapListeners]) listener(reminderId);
  };
  return { reminders, calls, logged, tap, tapListeners };
}

describe('registering a phone (phase 52, spec D4)', () => {
  it('creates the channel, reads the permission, fetches the token, then registers it', async () => {
    const { reminders, calls } = setup({ permission: 'granted' });
    await reminders.promptOnce();
    expect(calls).toEqual(['setChannel', 'permission', 'token', `registerPushDevice ${TOKEN}`]);
  });

  it('asks when the permission is undetermined, and registers once it is granted', async () => {
    const { reminders, calls } = setup({ permission: 'undetermined', answer: 'granted' });
    await reminders.promptOnce();
    expect(calls).toEqual(['setChannel', 'permission', 'requestPermission', 'token', `registerPushDevice ${TOKEN}`]);
  });

  it('registers without asking when the permission is already granted', async () => {
    const { reminders, calls } = setup({ permission: 'granted' });
    await reminders.promptOnce();
    expect(calls).not.toContain('requestPermission');
    expect(calls).toContain(`registerPushDevice ${TOKEN}`);
  });

  it('neither asks nor fetches a token when the permission is denied', async () => {
    const { reminders, calls } = setup({ permission: 'denied' });
    await reminders.promptOnce();
    expect(calls).toEqual(['setChannel', 'permission']);
  });

  it('fetches no token when the learner refuses', async () => {
    const { reminders, calls } = setup({ permission: 'undetermined', answer: 'denied' });
    await reminders.promptOnce();
    expect(calls).toEqual(['setChannel', 'permission', 'requestPermission']);
  });

  it('asks once per launch, even when the dialog was dismissed and left it undetermined', async () => {
    const { reminders, calls } = setup({ permission: 'undetermined', answer: 'undetermined' });
    await reminders.promptOnce();
    await reminders.promptOnce();
    expect(calls.filter((call) => call === 'requestPermission')).toEqual(['requestPermission']);
  });

  it('logs a token that cannot be fetched (no Firebase file yet) and registers nothing', async () => {
    const { reminders, calls, logged } = setup({ permission: 'granted', tokenFails: true });
    await expect(reminders.promptOnce()).resolves.toBeUndefined();
    expect(calls).toEqual(['setChannel', 'permission', 'token']);
    expect(logged.map(({ event }) => event)).toEqual(['reminder_token_failed']);
    expect(String(logged[0].detail)).toContain('no google-services.json');
  });

  it('logs a permission it could not read, and does not throw, since Home does not wait on it', async () => {
    const { reminders, calls, logged } = setup({ permissionFails: true });
    await expect(reminders.promptOnce()).resolves.toBeUndefined();
    expect(calls).toEqual(['setChannel', 'permission']);
    expect(logged.map(({ event }) => event)).toEqual(['reminder_prompt_failed']);
  });

  it('logs a registration the server did not take, and does not throw', async () => {
    const { reminders, logged } = setup({ permission: 'granted', apiFails: true });
    await expect(reminders.promptOnce()).resolves.toBeUndefined();
    expect(logged.map(({ event }) => event)).toEqual(['reminder_register_failed']);
  });
});

describe('enable, from the Reminders screen', () => {
  it('asks when undetermined, registers once granted, and answers the permission', async () => {
    const { reminders, calls } = setup({ permission: 'undetermined', answer: 'granted' });
    expect(await reminders.enable()).toBe('granted');
    expect(calls).toEqual(['setChannel', 'permission', 'requestPermission', 'token', `registerPushDevice ${TOKEN}`]);
  });

  it('asks again after promptOnce already asked, because the learner chose to', async () => {
    const { reminders, calls } = setup({ permission: 'undetermined', answer: 'undetermined' });
    await reminders.promptOnce();
    await reminders.enable();
    expect(calls.filter((call) => call === 'requestPermission')).toHaveLength(2);
  });

  it('answers denied with no token when Android keeps the refusal', async () => {
    const { reminders, calls } = setup({ permission: 'denied', answer: 'denied' });
    expect(await reminders.enable()).toBe('denied');
    expect(calls).not.toContain('token');
  });

  it('answers granted with no question when already granted', async () => {
    const { reminders, calls } = setup({ permission: 'granted' });
    expect(await reminders.enable()).toBe('granted');
    expect(calls).not.toContain('requestPermission');
    expect(calls).toContain(`registerPushDevice ${TOKEN}`);
  });

  it('answers granted when the token cannot be fetched, having logged it', async () => {
    const { reminders, calls, logged } = setup({ permission: 'granted', tokenFails: true });
    expect(await reminders.enable()).toBe('granted');
    expect(calls.some((call) => call.startsWith('registerPushDevice'))).toBe(false);
    expect(logged.map(({ event }) => event)).toEqual(['reminder_token_failed']);
  });

  it('reads the status without asking, and opens the settings', async () => {
    const { reminders, calls } = setup({ permission: 'denied' });
    expect(await reminders.status()).toBe('denied');
    await reminders.openSettings();
    expect(calls).toEqual(['permission', 'openSettings']);
  });
});

describe('where reminders are not supported', () => {
  const places = [
    { name: 'Expo Go on Android', platform: 'android', isExpoGo: true },
    { name: 'the web', platform: 'web', isExpoGo: false },
    { name: 'iOS', platform: 'ios', isExpoGo: false },
  ];

  for (const place of places) {
    it(`touches no engine in ${place.name}, and still reports the time zone`, async () => {
      const { reminders, calls } = setup({ permission: 'granted', lastTap: 'r1' }, place);
      expect(reminders.supported).toBe(false);
      expect(await reminders.status()).toBe('unsupported');
      expect(await reminders.enable()).toBe('unsupported');
      await reminders.promptOnce();
      await reminders.unregister();
      await reminders.openSettings();
      const stop = reminders.onTap(() => calls.push('go'));
      stop();
      await flush();
      await reminders.reportTimeZone();
      expect(calls).toEqual(['setTimeZone Asia/Jerusalem']);
    });
  }

  it('is supported on Android outside Expo Go', () => {
    expect(setup().reminders.supported).toBe(true);
  });
});

describe('the time zone (spec D1)', () => {
  it('reports the device zone', async () => {
    const { reminders, calls } = setup();
    await reminders.reportTimeZone();
    expect(calls).toEqual(['setTimeZone Asia/Jerusalem']);
  });

  it('logs a report that failed, and does not throw', async () => {
    const { reminders, logged } = setup({ apiFails: true });
    await expect(reminders.reportTimeZone()).resolves.toBeUndefined();
    expect(logged.map(({ event }) => event)).toEqual(['reminder_time_zone_failed']);
  });
});

describe('a tapped reminder (spec D6, D8)', () => {
  it('reports a tap with an id, then goes', async () => {
    const { reminders, calls, tap } = setup();
    reminders.onTap(() => calls.push('go'));
    await flush();
    calls.length = 0;
    tap('r1');
    await flush();
    expect(calls).toEqual(['tapReminder r1', 'go']);
  });

  it('just goes on a tap without an id', async () => {
    const { reminders, calls, tap } = setup();
    reminders.onTap(() => calls.push('go'));
    await flush();
    calls.length = 0;
    tap(null);
    await flush();
    expect(calls).toEqual(['go']);
  });

  it('still goes when the tap cannot be reported, having logged it', async () => {
    const { reminders, calls, logged, tap } = setup({ apiFails: true });
    reminders.onTap(() => calls.push('go'));
    await flush();
    tap('r1');
    await flush();
    expect(calls).toContain('go');
    expect(logged.map(({ event }) => event)).toEqual(['reminder_tap_failed']);
  });

  it('handles the tap that launched the app, from the last response', async () => {
    const { reminders, calls } = setup({ lastTap: 'r9' });
    reminders.onTap(() => calls.push('go'));
    await flush();
    expect(calls).toEqual(['onTap', 'lastTap', 'tapReminder r9', 'go']);
  });

  it('reads the last response once, however often it is subscribed', async () => {
    const { reminders, calls } = setup({ lastTap: 'r9' });
    // React's development mode mounts, unmounts and mounts an effect again.
    const stop = reminders.onTap(() => calls.push('go first'));
    stop();
    reminders.onTap(() => calls.push('go'));
    await flush();
    reminders.onTap(() => calls.push('go again'));
    await flush();
    expect(calls.filter((call) => call === 'lastTap')).toEqual(['lastTap']);
    expect(calls.filter((call) => call.startsWith('tapReminder') || call.startsWith('go'))).toEqual([
      'tapReminder r9',
      'go',
    ]);
  });

  it('does not go twice when the listener also hears the tap that launched the app', async () => {
    const { reminders, calls, tap } = setup({ lastTap: 'r9' });
    reminders.onTap(() => calls.push('go'));
    tap('r9');
    await flush();
    expect(calls.filter((call) => call === 'go')).toEqual(['go']);
    expect(calls.filter((call) => call.startsWith('tapReminder'))).toEqual(['tapReminder r9']);
  });

  it('logs a navigation that failed, rather than leaving it unhandled', async () => {
    const { reminders, logged } = setup({ lastTap: 'r9' });
    reminders.onTap(() => {
      throw new Error('no navigator');
    });
    await flush();
    expect(logged.map(({ event }) => event)).toEqual(['reminder_open_failed']);
  });

  it('stops listening once unsubscribed', async () => {
    const { reminders, calls, tap, tapListeners } = setup();
    const stop = reminders.onTap(() => calls.push('go'));
    stop();
    expect(tapListeners.size).toBe(0);
    tap('r1');
    await flush();
    expect(calls).not.toContain('go');
  });
});

describe('signing out (spec D4)', () => {
  it('unregisters the phone with its token', async () => {
    const { reminders, calls } = setup({ permission: 'granted' });
    await reminders.unregister();
    expect(calls).toEqual(['token', `unregisterPushDevice ${TOKEN}`]);
  });

  it('reuses the token this launch registered', async () => {
    const { reminders, calls } = setup({ permission: 'granted' });
    await reminders.promptOnce();
    calls.length = 0;
    await reminders.unregister();
    expect(calls).toEqual([`unregisterPushDevice ${TOKEN}`]);
  });

  it('logs an unregister that failed, and does not throw, so sign-out goes on', async () => {
    const tokenless = setup({ tokenFails: true });
    await expect(tokenless.reminders.unregister()).resolves.toBeUndefined();
    expect(tokenless.calls.some((call) => call.startsWith('unregisterPushDevice'))).toBe(false);
    expect(tokenless.logged.map(({ event }) => event)).toEqual(['reminder_unregister_failed']);

    const offline = setup({ permission: 'granted', apiFails: true });
    await expect(offline.reminders.unregister()).resolves.toBeUndefined();
    expect(offline.logged.map(({ event }) => event)).toEqual(['reminder_unregister_failed']);
  });
});
