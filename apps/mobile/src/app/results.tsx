import { Redirect, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSession } from '@/hooks/useSession';
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

  if (!session.hasSession) {
    return <Redirect href="/" />;
  }

  const { correctCount, total, missedQuestions } = session;

  // A new session, then replace: Results never stacks up behind itself.
  function onPractiseAgain() {
    session.start();
    router.replace('/session');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.headline}>{headlineFor(correctCount, total)}</Text>
        <Text style={styles.score}>{`${correctCount} / ${total}`}</Text>

        {missedQuestions.length > 0 ? (
          <View style={styles.missed}>
            <Text style={styles.missedTitle}>{strings.resultsMissedTitle}</Text>
            {missedQuestions.map(({ question, correct_answer }) => (
              <View key={question.id} style={styles.missedRow}>
                <Text style={styles.missedPrompt}>{question.question}</Text>
                <Text style={styles.missedAnswer}>{correct_answer}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={onPractiseAgain} style={styles.primary}>
          <Text style={styles.primaryLabel}>{strings.practiseAgain}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace('/')}
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
  },
  missed: { marginTop: spacing.lg, gap: spacing.sm },
  missedTitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
    color: colors.muted,
    textAlign: 'right',
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
  // reads LTR internally; the Hebrew side takes the remaining half.
  missedPrompt: {
    flex: 1,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    writingDirection: 'ltr',
    textAlign: 'right',
  },
  missedAnswer: {
    flex: 1,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
    textAlign: 'left',
  },
  actions: { paddingBottom: spacing.lg, gap: spacing.sm },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
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
