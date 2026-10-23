import type { MyWordsGoal } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/ScreenHeader';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { DEFAULT_GOAL, MAX_GOAL, MIN_GOAL, goalLabel, stepGoal } from '@/myWordsGoal';
import { createSaver } from '@/reminderSettings';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

// Phase 73 (spec D1). The active course's daily My words goal: a switch, and when it is on a
// − / + stepper. Each change is saved as it is made, the newest only, as new-words saves.
type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready' };

export default function MyWordsGoalScreen() {
  const api = useApi();
  const { user, active } = useCurrentUser();
  const enrollmentId = active?.id ?? null;

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [goal, setGoal] = useState<number | null>(null);
  // The newest goal, however many taps arrive between two renders.
  const latest = useRef<MyWordsGoal | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const read = useCallback(() => {
    if (!enrollmentId) return;
    setLoad({ kind: 'loading' });
    api
      .myWordsGoal(enrollmentId)
      .then((read) => {
        if (!live.current) return;
        latest.current = read;
        setGoal(read.goal);
        setLoad({ kind: 'ready' });
      })
      .catch(() => {
        if (live.current) setLoad({ kind: 'failed' });
      });
  }, [api, enrollmentId]);
  useEffect(read, [read]);

  const saver = useMemo(
    () =>
      createSaver(
        (body: MyWordsGoal) => {
          if (!enrollmentId) return Promise.reject(new Error('no active course'));
          return api.putMyWordsGoal(enrollmentId, body);
        },
        {
          onSaved: (saved) => {
            if (!live.current) return;
            latest.current = saved;
            setGoal(saved.goal);
          },
          // The screen showed a change that did not land: say so and show what is stored.
          onFailed: () => {
            if (!live.current) return;
            setSaveFailed(true);
            if (!enrollmentId) return;
            api
              .myWordsGoal(enrollmentId)
              .then((stored) => {
                if (!live.current) return;
                latest.current = stored;
                setGoal(stored.goal);
              })
              .catch(() => {});
          },
        },
      ),
    [api, enrollmentId],
  );

  function change(next: MyWordsGoal) {
    if (!latest.current || next.goal === latest.current.goal) return;
    latest.current = next;
    setGoal(next.goal);
    setSaveFailed(false);
    saver.save(next);
  }

  if (!user || !active) return <Redirect href="/" />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenHeader
          title={strings.myWordsGoalTitle(active.target_language)}
          onBack={() => router.back()}
          backTestID="my-words-goal-back"
        />

        {load.kind === 'loading' ? <ActivityIndicator testID="my-words-goal-loading" color={colors.primary} /> : null}

        {load.kind === 'failed' ? (
          <>
            <Text testID="my-words-goal-load-failed" style={styles.notice}>
              {strings.myWordsGoalLoadFailed}
            </Text>
            <Pressable
              accessibilityRole="button"
              testID="my-words-goal-retry"
              onPress={read}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>{strings.tryAgain}</Text>
            </Pressable>
          </>
        ) : null}

        {load.kind === 'ready' ? (
          <>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{strings.myWordsGoalSwitch}</Text>
                <Switch
                  testID="my-words-goal-on"
                  accessibilityLabel={strings.myWordsGoalSwitch}
                  value={goal !== null}
                  onValueChange={(on) => change({ goal: on ? DEFAULT_GOAL : null })}
                  trackColor={{ true: colors.primary, false: colors.border }}
                />
              </View>

              {goal !== null ? (
                <View style={styles.row}>
                  <View style={styles.stepper}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={strings.myWordsGoalLess}
                      testID="my-words-goal-less"
                      disabled={goal <= MIN_GOAL}
                      onPress={() => change({ goal: stepGoal(goal, -1) })}
                      style={[styles.stepButton, goal <= MIN_GOAL && styles.disabled]}
                    >
                      <Text style={styles.stepLabel}>−</Text>
                    </Pressable>
                    <Text testID="my-words-goal-value" style={styles.value}>
                      {goalLabel(goal)}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={strings.myWordsGoalMore}
                      testID="my-words-goal-more"
                      disabled={goal >= MAX_GOAL}
                      onPress={() => change({ goal: stepGoal(goal, 1) })}
                      style={[styles.stepButton, goal >= MAX_GOAL && styles.disabled]}
                    >
                      <Text style={styles.stepLabel}>+</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>

            {saveFailed ? (
              <Text testID="my-words-goal-save-failed" style={styles.notice}>
                {strings.myWordsGoalSaveFailed}
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
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  rowLabel: { flexShrink: 1, fontSize: fontSizes.md, color: colors.text, writingDirection: 'rtl' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    ...shadows.card,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { color: colors.primary, fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '700' },
  value: {
    minWidth: 96,
    textAlign: 'center',
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  disabled: { opacity: 0.5 },
  notice: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    ...shadows.card,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
