import type { Question } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedbackBanner } from '@/components/FeedbackBanner';
import { MultipleChoiceView } from '@/components/MultipleChoiceView';
import { ProgressBar } from '@/components/ProgressBar';
import { useSession } from '@/hooks/useSession';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

// The one place phase 1 dispatches on question type. Adding a question type
// means a new case here plus a new view component; the header, progress bar,
// feedback banner and scoring are untouched.
function renderQuestion(
  question: Question,
  selectedOption: number | null,
  onSelect: (optionIndex: number) => void,
) {
  switch (question.type) {
    case 'multiple_choice':
      return (
        <MultipleChoiceView
          question={question}
          selectedOption={selectedOption}
          onSelect={onSelect}
        />
      );
    default:
      // Unreachable while Question has a single member. Once a second question
      // type joins the union, replace this line with
      // `const unhandled: never = question;` and TypeScript will fail the build
      // on any unhandled type.
      throw new Error('unhandled question type');
  }
}

export default function SessionScreen() {
  const session = useSession();

  // Results replaces Session in the stack, so backing out of Results reaches
  // Home rather than a finished quiz.
  useEffect(() => {
    if (session.hasSession && session.complete) {
      router.replace('/results');
    }
  }, [session.hasSession, session.complete]);

  if (!session.hasSession) {
    return <Redirect href="/" />;
  }

  const question = session.question;
  if (!question) {
    return null;
  }

  const isCorrect = session.selectedOption === question.correct_option;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" hitSlop={12} onPress={() => router.back()}>
          <Text style={styles.back}>{'→'}</Text>
        </Pressable>
        <Text style={styles.counter} testID="progress-label">
          {strings.progressLabel(session.position, session.total)}
        </Text>
      </View>

      <ProgressBar position={session.position} total={session.total} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {renderQuestion(question, session.selectedOption, session.select)}
      </ScrollView>

      {session.answered ? (
        <FeedbackBanner
          isCorrect={isCorrect}
          correctAnswer={question.options[question.correct_option]}
          onContinue={session.next}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
  },
  // A glyph, not an icon, so it is not auto-mirrored. Back points right in RTL.
  back: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.muted },
  // Direction is handled in the string itself: see strings.progressLabel.
  counter: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    fontWeight: '700',
  },
  // Bottom padding keeps the last option clear of the overlaid banner.
  body: { paddingTop: spacing.xl, paddingBottom: spacing.xxl * 4 },
});
