import type { ReminderSettings, ReminderSettingsResponse } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useReminders } from '@/hooks/useReminders';
import type { Permission } from '@/reminders';
import {
  HOURS,
  MAX_TARGET,
  MIN_TARGET,
  WEEK_DAYS,
  createSaver,
  hourId,
  stepTarget,
  timeOf,
  toggleDay,
  toggleHour,
} from '@/reminderSettings';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

// Phase 52 (spec D8). The learner's reminder schedule: on or off, the daily
// target, the days and the hours. Each change is saved as it is made, and the
// permission the phone needs is asked for here when the Home screen's one ask
// was refused or never answered.
type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready' };

const toWire = ({ enabled, daily_target, days, times }: ReminderSettingsResponse): ReminderSettings => ({
  enabled,
  daily_target,
  days,
  times,
});

function Chip({
  label,
  selected,
  testID,
  onPress,
}: {
  label: string;
  selected: boolean;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      // react-native-web 0.21 does not render accessibilityState, so on web this
      // is what puts the choice in the DOM (and in a test).
      aria-selected={selected}
      testID={testID}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipOn]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelOn]}>{label}</Text>
    </Pressable>
  );
}

export default function RemindersScreen() {
  const api = useApi();
  const reminders = useReminders();
  const { user } = useCurrentUser();

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [settings, setSettings] = useState<ReminderSettingsResponse | null>(null);
  // The newest settings, however many taps arrive between two renders.
  const latest = useRef<ReminderSettingsResponse | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [permission, setPermission] = useState<Permission | 'unsupported' | null>(null);
  const [asking, setAsking] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const read = useCallback(() => {
    setLoad({ kind: 'loading' });
    api
      .reminderSettings()
      .then((read) => {
        if (!live.current) return;
        latest.current = read;
        setSettings(read);
        setLoad({ kind: 'ready' });
      })
      .catch(() => {
        if (live.current) setLoad({ kind: 'failed' });
      });
  }, [api]);
  useEffect(read, [read]);

  const saver = useMemo(
    () =>
      createSaver(api.putReminderSettings, {
        // The server sorts and drops repeats; what it kept is what is shown.
        onSaved: (saved) => {
          if (!live.current) return;
          latest.current = saved;
          setSettings(saved);
        },
        // The screen showed a change that did not land: say so and show what is stored.
        onFailed: () => {
          if (!live.current) return;
          setSaveFailed(true);
          api
            .reminderSettings()
            .then((stored) => {
              if (!live.current) return;
              latest.current = stored;
              setSettings(stored);
            })
            .catch(() => {});
        },
      }),
    [api],
  );

  function change(update: (current: ReminderSettingsResponse) => ReminderSettingsResponse) {
    if (!latest.current) return;
    const next = update(latest.current);
    latest.current = next;
    setSettings(next);
    setSaveFailed(false);
    saver.save(toWire(next));
  }

  // The permission is read on arrival, and again whenever the app comes back to
  // the front: a refusal is undone in Android's settings, not here. If it turned
  // granted since, this phone is registered now (enable registers once granted),
  // which Home would otherwise do only at the next launch.
  const lastPermission = useRef<Permission | 'unsupported' | null>(null);
  useEffect(() => {
    let current = true;
    const refresh = async () => {
      try {
        const status = await reminders.status();
        const was = lastPermission.current;
        lastPermission.current = status;
        if (current) setPermission(status);
        if (status === 'granted' && was !== null && was !== 'granted') await reminders.enable();
      } catch {
        // Unreadable: the screen keeps what it showed.
      }
    };
    void refresh();
    const subscription = reminders.supported
      ? AppState.addEventListener('change', (state) => {
          if (state === 'active') void refresh();
        })
      : null;
    return () => {
      current = false;
      subscription?.remove();
    };
  }, [reminders]);

  async function onEnable() {
    if (asking) return;
    setAsking(true);
    try {
      const answer = await reminders.enable();
      lastPermission.current = answer;
      if (live.current) setPermission(answer);
    } catch {
      // The permission could not be asked; the button stays for another try.
    } finally {
      if (live.current) setAsking(false);
    }
  }

  if (!user) return <Redirect href="/" />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{strings.remindersTitle}</Text>

        {permission === 'unsupported' ? (
          <Text testID="reminders-unsupported" style={styles.notice}>
            {strings.remindersWebNotice}
          </Text>
        ) : null}

        {permission === 'denied' ? (
          <View style={styles.card}>
            <Text testID="reminders-denied" style={styles.notice}>
              {strings.remindersDeniedNotice}
            </Text>
            <Pressable
              accessibilityRole="button"
              testID="reminders-open-settings"
              onPress={() => void reminders.openSettings().catch(() => {})}
              style={styles.button}
            >
              <Text style={styles.buttonLabel}>{strings.remindersOpenSettings}</Text>
            </Pressable>
          </View>
        ) : null}

        {permission === 'undetermined' ? (
          <Pressable
            accessibilityRole="button"
            testID="reminders-enable"
            disabled={asking}
            onPress={() => void onEnable()}
            style={[styles.button, asking && styles.disabled]}
          >
            <Text style={styles.buttonLabel}>{strings.remindersEnable}</Text>
          </Pressable>
        ) : null}

        {load.kind === 'loading' ? <ActivityIndicator testID="reminders-loading" color={colors.primary} /> : null}

        {load.kind === 'failed' ? (
          <>
            <Text testID="reminders-load-failed" style={styles.notice}>
              {strings.remindersLoadFailed}
            </Text>
            <Pressable
              accessibilityRole="button"
              testID="reminders-retry"
              onPress={read}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>{strings.tryAgain}</Text>
            </Pressable>
          </>
        ) : null}

        {load.kind === 'ready' && settings ? (
          <>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{strings.remindersEnabled}</Text>
                <Switch
                  testID="reminders-enabled"
                  accessibilityLabel={strings.remindersEnabled}
                  value={settings.enabled}
                  onValueChange={(enabled) => change((current) => ({ ...current, enabled }))}
                  trackColor={{ true: colors.primary, false: colors.border }}
                />
              </View>

              <View style={styles.row}>
                <Text style={styles.rowLabel}>{strings.remindersTargetLabel}</Text>
                <View style={styles.stepper}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={strings.remindersTargetLess}
                    testID="reminders-target-minus"
                    disabled={settings.daily_target <= MIN_TARGET}
                    onPress={() =>
                      change((current) => ({ ...current, daily_target: stepTarget(current.daily_target, -1) }))
                    }
                    style={[styles.stepButton, settings.daily_target <= MIN_TARGET && styles.disabled]}
                  >
                    <Text style={styles.stepLabel}>−</Text>
                  </Pressable>
                  <Text testID="reminders-target" style={styles.target}>
                    {String(settings.daily_target)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={strings.remindersTargetMore}
                    testID="reminders-target-plus"
                    disabled={settings.daily_target >= MAX_TARGET}
                    onPress={() =>
                      change((current) => ({ ...current, daily_target: stepTarget(current.daily_target, 1) }))
                    }
                    style={[styles.stepButton, settings.daily_target >= MAX_TARGET && styles.disabled]}
                  >
                    <Text style={styles.stepLabel}>+</Text>
                  </Pressable>
                </View>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>{strings.remindersDaysLabel}</Text>
              <View style={styles.chips}>
                {WEEK_DAYS.map((day) => (
                  <Chip
                    key={day}
                    label={strings.remindersDayName(day)}
                    selected={settings.days.includes(day)}
                    testID={`reminders-day-${day}`}
                    onPress={() => change((current) => ({ ...current, days: toggleDay(current.days, day) }))}
                  />
                ))}
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>{strings.remindersTimesLabel}</Text>
              <View style={styles.chips}>
                {HOURS.map((hour) => (
                  <Chip
                    key={hour}
                    label={strings.remindersTime(timeOf(hour))}
                    selected={settings.times.includes(timeOf(hour))}
                    testID={`reminders-hour-${hourId(hour)}`}
                    onPress={() => change((current) => ({ ...current, times: toggleHour(current.times, hour) }))}
                  />
                ))}
              </View>
            </View>

            {saveFailed ? (
              <Text testID="reminders-save-failed" style={styles.notice}>
                {strings.remindersSaveFailed}
              </Text>
            ) : null}
          </>
        ) : null}

        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}>
          <Text style={styles.secondaryLabel}>{strings.back}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.lg, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  cardTitle: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
    paddingVertical: spacing.sm,
    writingDirection: 'rtl',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  rowLabel: { fontSize: fontSizes.md, color: colors.text, writingDirection: 'rtl' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { color: colors.primary, fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '700' },
  target: {
    minWidth: 24,
    textAlign: 'center',
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    color: colors.text,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingBottom: spacing.sm },
  chip: {
    minWidth: 64,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { color: colors.text, fontSize: fontSizes.md, fontWeight: '700' },
  chipLabelOn: { color: colors.onPrimary },
  notice: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  disabled: { opacity: 0.5 },
  secondary: { paddingVertical: spacing.sm, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
