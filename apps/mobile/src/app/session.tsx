import type { Question } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedbackBanner } from '@/components/FeedbackBanner';
import { MultipleChoiceView } from '@/components/MultipleChoiceView';
import { ProgressBar } from '@/components/ProgressBar';
import { TypedAnswerView } from '@/components/TypedAnswerView';
import { confirm } from '@/confirm';
import { feedbackFor } from '@/feedback';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { useSession, type SessionValue } from '@/hooks/useSession';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

// The one place the session screen dispatches on question type. Adding a type
// means a new case here plus a view component; the header, progress bar,
// feedback banner and scoring are untouched, and the `never` below fails the
// build for a type with no case.
function renderQuestion(question: Question, session: SessionValue, language: string) {
  switch (question.type) {
    case 'multiple_choice':
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstruction}
          selectedOption={session.selectedOption}
          onSelect={session.select}
        />
      );
    case 'reverse_choice':
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstructionReverse(language)}
          selectedOption={session.selectedOption}
          onSelect={session.select}
        />
      );
    case 'typed_translation':
      return (
        <TypedAnswerView
          question={question}
          instruction={strings.questionInstructionTyped(language)}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer).verdict : null}
          onSubmit={session.submitText}
        />
      );
    default: {
      const unhandled: never = question;
      throw new Error(`unhandled question type: ${JSON.stringify(unhandled)}`);
    }
  }
}

export default function SessionScreen() {
  const session = useSession();
  const next = useNextSession();
  const { active } = useCurrentUser();
  // Re-entry guard: a fast double tap on skip must not stack two confirms.
  const skipping = useRef(false);

  // Results replaces Session in the stack, so backing out of Results reaches
  // Home rather than a finished quiz.
  useEffect(() => {
    if (session.hasSession && session.complete) {
      router.replace('/results');
    }
  }, [session.hasSession, session.complete]);

  async function onSkip() {
    const sessionId = session.sessionId;
    if (!sessionId || skipping.current) return;
    skipping.current = true;
    try {
      const sure = await confirm({
        title: strings.skipConfirmTitle,
        message: strings.skipConfirmMessage,
        confirm: strings.skip,
        cancel: strings.cancel,
      });
      if (!sure) return;
      // A failure needs nothing more here: home re-reads the state on focus.
      await next.skip(sessionId).catch(() => undefined);
      router.dismissTo('/');
    } finally {
      skipping.current = false;
    }
  }

  if (!session.hasSession) {
    return <Redirect href="/" />;
  }

  const question = session.question;
  if (!question) {
    return null;
  }

  // A session is always entered from home, which needs an active enrollment;
  // an empty language only drops the name from the instruction.
  const language = active?.target_language ?? '';

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* The keyboard must not cover the typed card's input and its button. */}
      <KeyboardAvoidingView style={styles.avoid} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" testID="session-back" hitSlop={12} onPress={() => router.back()}>
            <Text style={styles.back}>{'→'}</Text>
          </Pressable>
          <View style={styles.headerEnd}>
            <Text style={styles.counter} testID="progress-label">
              {strings.progressLabel(session.position, session.total)}
            </Text>
            <Pressable accessibilityRole="button" testID="session-skip" hitSlop={12} onPress={() => void onSkip()}>
              <Text style={styles.skip}>{strings.skip}</Text>
            </Pressable>
          </View>
        </View>

        <ProgressBar position={session.position} total={session.total} />

        {/* "handled": with the keyboard up, the first tap on בדיקה must submit,
            not merely dismiss the keyboard. */}
        <ScrollView
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {renderQuestion(question, session, language)}
        </ScrollView>
      </KeyboardAvoidingView>

      {session.answer ? (
        <FeedbackBanner feedback={feedbackFor(question, session.answer)} onContinue={session.next} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  avoid: { flex: 1 },
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
  headerEnd: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  skip: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, fontWeight: '700' },
  // Bottom padding keeps the last option clear of the overlaid banner.
  body: { paddingTop: spacing.xl, paddingBottom: spacing.xxl * 4 },
});
