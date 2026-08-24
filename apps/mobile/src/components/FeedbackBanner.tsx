import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';

import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  isCorrect: boolean;
  correctAnswer: string;
  onContinue: () => void;
};

const HIDDEN_OFFSET = 200;

export function FeedbackBanner({ isCorrect, correctAnswer, onContinue }: Props) {
  const translateY = useRef(new Animated.Value(HIDDEN_OFFSET)).current;

  useEffect(() => {
    translateY.setValue(HIDDEN_OFFSET);
    Animated.timing(translateY, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [translateY, correctAnswer]);

  return (
    <Animated.View
      style={[
        styles.banner,
        isCorrect ? styles.bannerCorrect : styles.bannerWrong,
        { transform: [{ translateY }] },
      ]}
    >
      <Text style={[styles.title, isCorrect ? styles.titleCorrect : styles.titleWrong]}>
        {isCorrect ? strings.feedbackCorrect : strings.feedbackWrong}
      </Text>
      {isCorrect ? null : <Text style={styles.answer}>{correctAnswer}</Text>}
      <Pressable accessibilityRole="button" onPress={onContinue} style={styles.button}>
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
    paddingBottom: spacing.xl,
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
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  titleCorrect: { color: colors.correct },
  titleWrong: { color: colors.wrong },
  answer: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    textAlign: 'right',
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
