import { Pressable, StyleSheet, Text, type LayoutChangeEvent } from 'react-native';

import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export type OptionVisualState = 'idle' | 'correct' | 'wrong' | 'dimmed' | 'selected';

type Props = {
  label: string;
  /** Phase 23. A reversed card's options are target-language words. */
  direction: 'rtl' | 'ltr';
  state: OptionVisualState;
  disabled: boolean;
  minHeight?: number;
  /** Phase 34 (spec D10). A small Hebrew line under the label: a board word's
   *  part of speech. */
  note?: string;
  testID?: string;
  onPress: () => void;
  onMeasure: (height: number) => void;
};

export function OptionButton({ label, direction, state, disabled, minHeight, note, testID, onPress, onMeasure }: Props) {
  function handleLayout(event: LayoutChangeEvent) {
    onMeasure(event.nativeEvent.layout.height);
  }

  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      onLayout={handleLayout}
      style={({ pressed }) => [
        styles.base,
        stateStyles[state],
        minHeight ? { minHeight } : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.label, { writingDirection: direction }, state === 'dimmed' ? styles.labelDimmed : null]}>
        {label}
      </Text>
      {note === undefined ? null : (
        <Text style={styles.note} testID={testID === undefined ? undefined : `${testID}-note`}>
          {note}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  label: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
  },
  labelDimmed: { color: colors.muted },
  note: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
});

const stateStyles = StyleSheet.create({
  idle: {},
  correct: { borderColor: colors.correct, backgroundColor: colors.correctSurface },
  wrong: { borderColor: colors.wrong, backgroundColor: colors.wrongSurface },
  dimmed: { opacity: 0.45 },
  // Phase 24. A board's word or meaning waiting for its pair.
  selected: { borderColor: colors.primary, borderWidth: 2 },
});
