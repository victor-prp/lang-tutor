import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SentenceLine } from '@/explain';
import type { Feedback } from '@/feedback';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  feedback: Feedback;
  onContinue: () => void;
  /** Phase 66b (spec D2). A translation's sentence, checked with its word: a
   *  second line under the word's, and הסבר on it when there is a fix to explain.
   *  None: the banner as it always was. */
  sentence?: { line: SentenceLine; open: boolean; onExplain: () => void } | null;
};

// U+2068 FSI ... U+2069 PDI: the line may be a target-language word inside a
// right-to-left banner, and isolating it keeps its punctuation in place.
const isolate = (text: string) => `\u2068${text}\u2069`;

const HIDDEN_OFFSET = 200;

export function FeedbackBanner({ feedback, onContinue, sentence = null }: Props) {
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
      <View style={styles.row}>
        {sentence !== null && tone.mark !== null ? <Mark glyph={tone.mark.glyph} color={tone.mark.color} /> : null}
        <Text style={[styles.title, tone.title]} testID="feedback-title">
          {feedback.title}
        </Text>
      </View>
      {feedback.line === null ? null : (
        <Text style={styles.answer} testID="feedback-line">
          {isolate(feedback.line)}
        </Text>
      )}
      {sentence === null ? null : (
        <View style={styles.row}>
          <Mark glyph={sentence.line === 'fix' ? '!' : '✓'} color={sentence.line === 'fix' ? colors.amber : colors.correct} />
          <Text style={[styles.sentence, sentence.line === 'fix' ? styles.sentenceFix : styles.sentenceRight]} testID="sentence-line">
            {sentence.line === 'fix' ? strings.sentenceNeedsFix : strings.sentenceRight}
          </Text>
          {sentence.line === 'fix' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: sentence.open }}
              aria-expanded={sentence.open}
              hitSlop={8}
              testID="explain-button"
              onPress={sentence.onExplain}
              style={[styles.explain, sentence.open && styles.explainOpen]}
            >
              <Text style={[styles.explainLabel, sentence.open && styles.explainLabelOpen]}>{strings.explainButton}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      <Pressable accessibilityRole="button" testID="continue-button" onPress={onContinue} style={styles.button}>
        <Text style={styles.buttonLabel}>{strings.continueLabel}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** Phase 66b (spec D2). A line's round mark: ✓, ✕ or !. */
function Mark({ glyph, color }: { glyph: string; color: string }) {
  return (
    <View style={[styles.mark, { backgroundColor: color }]}>
      <Text style={styles.markGlyph}>{glyph}</Text>
    </View>
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
    flexShrink: 1,
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  titleCorrect: { color: colors.correct },
  titleWrong: { color: colors.wrong },
  titleOther: { color: colors.text },
  // Phase 66b (spec D2). The word's line and the sentence's, each led by its mark.
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  mark: { width: 24, height: 24, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  markGlyph: { color: colors.onPrimary, fontSize: fontSizes.sm, lineHeight: 18, fontWeight: '700' },
  sentence: { flexShrink: 1, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700', writingDirection: 'rtl' },
  sentenceRight: { color: colors.correct },
  sentenceFix: { color: colors.amberText },
  explain: {
    marginStart: 'auto',
    paddingHorizontal: spacing.md,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  explainOpen: { backgroundColor: colors.primary },
  explainLabel: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.primary, fontWeight: '600' },
  explainLabelOpen: { color: colors.onPrimary },
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

// Phase 66b (spec D2): `mark` leads the word's line when the sentence has one too.
const TONES = {
  correct: { testID: 'feedback-correct', banner: styles.bannerCorrect, title: styles.titleCorrect, mark: { glyph: '✓', color: colors.correct } },
  wrong: { testID: 'feedback-wrong', banner: styles.bannerWrong, title: styles.titleWrong, mark: { glyph: '✕', color: colors.wrong } },
  other: { testID: 'feedback-other', banner: styles.bannerOther, title: styles.titleOther, mark: null },
} as const;
