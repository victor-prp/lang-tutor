import { Redirect, router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LevelBadge } from '@/components/LevelBadge';
import { useNextSession } from '@/hooks/useNextSession';
import { useSession } from '@/hooks/useSession';
import { practisedRows } from '@/progress';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

function headlineFor(correct: number, total: number): string {
  const ratio = total === 0 ? 0 : correct / total;
  if (ratio >= 0.9) return strings.resultsHeadlineGreat;
  if (ratio >= 0.6) return strings.resultsHeadlineGood;
  return strings.resultsHeadlineKeepPractising;
}

export default function ResultsScreen() {
  const session = useSession();
  const next = useNextSession();
  // A ref guards re-entry (state is stale between two taps in one frame); the
  // state only drives the disabled look.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  if (!session.hasSession) {
    return <Redirect href="/" />;
  }

  const { correctCount, total, missedQuestions, progress } = session;

  // Creates the next session and goes home, rather than straight into a quiz:
  // a list session is still preparing at this moment. Home shows its state,
  // or why there is none (no saved words).
  async function onNextSession() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await next.create().catch(() => undefined);
      router.dismissTo('/');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.headline}>{headlineFor(correctCount, total)}</Text>
        <Text style={styles.score} testID="results-score">{strings.scoreLabel(correctCount, total)}</Text>

        {progress.length > 0 ? (
          <View style={styles.missed} testID="practised-section">
            <Text style={styles.missedTitle}>{strings.resultsPractisedTitle}</Text>
            {practisedRows(progress).map((row) => (
              <View key={row.sense_id} style={[styles.missedRow, row.raised && styles.raisedRow]} testID="practised-row">
                <View style={styles.missedCellStart}>
                  <Text style={styles.missedPrompt}>{row.form}</Text>
                </View>
                <View style={styles.missedCellEnd}>
                  <Text style={styles.missedAnswer}>{row.translation}</Text>
                  <LevelBadge level={row.level_after} testID="practised-level" />
                  {row.raised ? (
                    <Text style={styles.raised} testID="practised-raised">
                      {strings.levelRaised(row.level_after)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {missedQuestions.length > 0 ? (
          <View style={styles.missed}>
            <Text style={styles.missedTitle}>{strings.resultsMissedTitle}</Text>
            {missedQuestions.map(({ question, correct_answer }) => (
              <View key={question.id} style={styles.missedRow} testID="missed-row">
                <View style={styles.missedCellStart}>
                  <Text style={styles.missedPrompt}>{question.question}</Text>
                </View>
                <View style={styles.missedCellEnd}>
                  <Text style={styles.missedAnswer}>{correct_answer}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          testID="results-next-session"
          disabled={busy}
          onPress={() => void onNextSession()}
          style={[styles.primary, busy && styles.primaryDisabled]}
        >
          <Text style={styles.primaryLabel}>{strings.nextSession}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          testID="results-done"
          // dismissTo, not replace: Results sits on top of the home that
          // started the session, and replacing it would leave that home
          // stale underneath a second one.
          onPress={() => router.dismissTo('/')}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>{strings.done}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg },
  body: { paddingTop: spacing.xxl, paddingBottom: spacing.xl, gap: spacing.md },
  headline: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  score: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'center',
    // Direction is handled in the string itself: see strings.scoreLabel.
  },
  missed: { marginTop: spacing.lg, gap: spacing.sm },
  missedTitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
    color: colors.muted,
    writingDirection: 'rtl',
  },
  missedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  // The English side sits at the start of the row (the right, under RTL) and
  // keeps an LTR base direction so its punctuation stays put; the Hebrew side
  // takes the remaining half. Alignment comes from these flex cells rather
  // than a physical textAlign, which native RTL would swap.
  missedCellStart: { flex: 1, alignItems: 'flex-start' },
  missedCellEnd: { flex: 1, alignItems: 'flex-end' },
  missedPrompt: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    writingDirection: 'ltr',
  },
  missedAnswer: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
  raisedRow: { borderColor: colors.primary, borderWidth: 2 },
  raised: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    fontWeight: '700',
    color: colors.primary,
    writingDirection: 'rtl',
  },
  actions: { paddingBottom: spacing.lg, gap: spacing.sm },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  primaryDisabled: { opacity: 0.6 },
  primaryLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: {
    color: colors.muted,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
});
