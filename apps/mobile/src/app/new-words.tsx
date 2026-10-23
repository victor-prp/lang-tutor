import type { NewWordLimits } from '@lang-tutor/core/api';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '@/components/Chip';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { DAY_CAP_OPTIONS, DISCOVER_COUNT_OPTIONS, PER_SESSION_OPTIONS, withDayCap, withDiscoverCount, withPerSession } from '@/newWordLimits';
import { createAskSwitch } from '@/practiceMoreAsk';
import { createSaver } from '@/reminderSettings';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

// Phase 70 (spec D7). The learner's new-word limits: how many a day, how many a session, and
// whether a session the day's cap held words back from says so. Phase 74 (spec D10): how many
// words Words for me adds when the app sends the learner there. Each tap is saved as it is
// made, the newest only, as the reminders screen saves.
type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready' };

export default function NewWordsScreen() {
  const api = useApi();
  const { user, newWordCapNotice } = useCurrentUser();

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [limits, setLimits] = useState<NewWordLimits | null>(null);
  // The newest limits, however many taps arrive between two renders.
  const latest = useRef<NewWordLimits | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
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
      .newWordLimits()
      .then((read) => {
        if (!live.current) return;
        latest.current = read;
        setLimits(read);
        setLoad({ kind: 'ready' });
      })
      .catch(() => {
        if (live.current) setLoad({ kind: 'failed' });
      });
  }, [api]);
  useEffect(read, [read]);

  const saver = useMemo(
    () =>
      createSaver(api.putNewWordLimits, {
        onSaved: (saved) => {
          if (!live.current) return;
          latest.current = saved;
          setLimits(saved);
        },
        // The screen showed a change that did not land: say so and show what is stored.
        onFailed: () => {
          if (!live.current) return;
          setSaveFailed(true);
          api
            .newWordLimits()
            .then((stored) => {
              if (!live.current) return;
              latest.current = stored;
              setLimits(stored);
            })
            .catch(() => {});
        },
      }),
    [api],
  );

  function change(update: (current: NewWordLimits) => NewWordLimits) {
    if (!latest.current) return;
    const next = update(latest.current);
    if (
      next.day_cap === latest.current.day_cap &&
      next.per_session === latest.current.per_session &&
      next.discover_count === latest.current.discover_count
    )
      return;
    latest.current = next;
    setLimits(next);
    setSaveFailed(false);
    saver.save(next);
  }

  // Spec D6. The message's switch: the sheet's tick box turns it off, this turns it back on. Read
  // each time the screen is shown, as הגדרות reads the practice-more switch.
  const [notice, setNotice] = useState(true);
  const username = user?.username;
  const noticeSwitch = useMemo(
    () => (username ? createAskSwitch(newWordCapNotice, username, setNotice) : null),
    [username, newWordCapNotice],
  );
  useFocusEffect(useCallback(() => noticeSwitch?.read(), [noticeSwitch]));
  const changeNotice = (show: boolean) => (noticeSwitch ? noticeSwitch.flip(show) : setNotice(show));

  if (!user) return <Redirect href="/" />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenHeader title={strings.newWordsTitle} onBack={() => router.back()} backTestID="new-words-back" />

        {load.kind === 'loading' ? <ActivityIndicator testID="new-words-loading" color={colors.primary} /> : null}

        {load.kind === 'failed' ? (
          <>
            <Text testID="new-words-load-failed" style={styles.notice}>
              {strings.newWordsLoadFailed}
            </Text>
            <Pressable accessibilityRole="button" testID="new-words-retry" onPress={read} style={styles.secondaryButton}>
              <Text style={styles.secondaryLabel}>{strings.tryAgain}</Text>
            </Pressable>
          </>
        ) : null}

        {load.kind === 'ready' && limits ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{strings.newWordsDayLabel}</Text>
              <View style={styles.chips}>
                {DAY_CAP_OPTIONS.map((cap) => (
                  <Chip
                    key={cap}
                    label={String(cap)}
                    selected={limits.day_cap === cap}
                    testID={`new-words-day-${cap}`}
                    onPress={() => change((current) => withDayCap(current, cap))}
                  />
                ))}
              </View>
              <Text style={styles.hint}>{strings.newWordsDayHint}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>{strings.newWordsSessionLabel}</Text>
              <View style={styles.chips}>
                {PER_SESSION_OPTIONS.map((perSession) => (
                  <Chip
                    key={perSession ?? 'auto'}
                    label={perSession === null ? strings.newWordsAuto : String(perSession)}
                    selected={limits.per_session === perSession}
                    testID={`new-words-session-${perSession ?? 'auto'}`}
                    onPress={() => change((current) => withPerSession(current, perSession))}
                  />
                ))}
              </View>
              <Text style={styles.hint}>{strings.newWordsSessionHint}</Text>
            </View>

            {/* Phase 74 (spec D10): how many words a run of Words for me the app starts collects. */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{strings.discoverEntry}</Text>
              <Text style={styles.hint}>{strings.newWordsDiscoverLabel}</Text>
              <View style={styles.chips}>
                {DISCOVER_COUNT_OPTIONS.map((count) => (
                  <Chip
                    key={count}
                    label={String(count)}
                    selected={limits.discover_count === count}
                    testID={`settings-discover-count-${count}`}
                    onPress={() => change((current) => withDiscoverCount(current, count))}
                  />
                ))}
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{strings.newWordsNoticeSwitch}</Text>
                <Switch
                  testID="new-words-notice"
                  accessibilityLabel={strings.newWordsNoticeSwitch}
                  value={notice}
                  onValueChange={changeNotice}
                  trackColor={{ true: colors.primary, false: colors.border }}
                />
              </View>
            </View>

            {saveFailed ? (
              <Text testID="new-words-save-failed" style={styles.notice}>
                {strings.newWordsSaveFailed}
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    ...shadows.card,
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
    gap: spacing.md,
  },
  rowLabel: { flexShrink: 1, fontSize: fontSizes.md, color: colors.text, writingDirection: 'rtl' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingBottom: spacing.sm },
  hint: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    color: colors.muted,
    paddingBottom: spacing.sm,
    writingDirection: 'rtl',
  },
  notice: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    ...shadows.card,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
