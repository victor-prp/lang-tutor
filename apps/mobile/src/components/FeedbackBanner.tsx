import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Feedback } from '@/feedback';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  feedback: Feedback;
  onContinue: () => void;
};

// U+2068 FSI ... U+2069 PDI: the line may be a target-language word inside a
// right-to-left banner, and isolating it keeps its punctuation in place.
const isolate = (text: string) => `\u2068${text}\u2069`;

const HIDDEN_OFFSET = 200;

export function FeedbackBanner({ feedback, onContinue }: Props) {
  const isCorrect = feedback.tone === 'correct';
  const translateY = useRef(new Animated.Value(HIDDEN_OFFSET)).current;
  // The banner is absolutely positioned, so it sits outside the screen's
  // SafeAreaView padding and would otherwise run under the Android nav bar.
  const insets = useSafeAreaInsets();

  useEffect(() => {
    translateY.setValue(HIDDEN_OFFSET);
    Animated.timing(translateY, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [translateY, feedback.title, feedback.line]);

  return (
    <Animated.View
      testID={isCorrect ? 'feedback-correct' : 'feedback-wrong'}
      style={[
        styles.banner,
        isCorrect ? styles.bannerCorrect : styles.bannerWrong,
        { paddingBottom: insets.bottom + spacing.xl, transform: [{ translateY }] },
      ]}
    >
      <Text style={[styles.title, isCorrect ? styles.titleCorrect : styles.titleWrong]} testID="feedback-title">
        {feedback.title}
      </Text>
      {feedback.line === null ? null : (
        <Text style={styles.answer} testID="feedback-line">
          {isolate(feedback.line)}
        </Text>
      )}
      <Pressable accessibilityRole="button" testID="continue-button" onPress={onContinue} style={styles.button}>
        <Text style={styles.buttonLabel}>{strings.continueLabel}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    gap: spacing.sm,
  },
  bannerCorrect: { backgroundColor: colors.correctSurface },
  bannerWrong: { backgroundColor: colors.wrongSurface },
  title: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  titleCorrect: { color: colors.correct },
  titleWrong: { color: colors.wrong },
  answer: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    writingDirection: 'rtl',
  },
  button: {
    marginTop: spacing.sm,
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
});
