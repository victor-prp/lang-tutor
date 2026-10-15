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
  // Phase 45 (spec D1): `other` is neither right nor wrong, on the plain surface.
  const tone = TONES[feedback.tone];
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
      testID={tone.testID}
      style={[
        styles.banner,
        tone.banner,
        { paddingBottom: insets.bottom + spacing.xl, transform: [{ translateY }] },
      ]}
    >
      <Text style={[styles.title, tone.title]} testID="feedback-title">
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
  bannerOther: { backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border },
  title: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  titleCorrect: { color: colors.correct },
  titleWrong: { color: colors.wrong },
  titleOther: { color: colors.text },
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

const TONES = {
  correct: { testID: 'feedback-correct', banner: styles.bannerCorrect, title: styles.titleCorrect },
  wrong: { testID: 'feedback-wrong', banner: styles.bannerWrong, title: styles.titleWrong },
  other: { testID: 'feedback-other', banner: styles.bannerOther, title: styles.titleOther },
} as const;
