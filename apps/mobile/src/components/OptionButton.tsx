import { Pressable, StyleSheet, Text, type LayoutChangeEvent } from 'react-native';

import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export type OptionVisualState = 'idle' | 'correct' | 'wrong' | 'dimmed';

type Props = {
  label: string;
  state: OptionVisualState;
  disabled: boolean;
  minHeight?: number;
  onPress: () => void;
  onMeasure: (height: number) => void;
};

export function OptionButton({ label, state, disabled, minHeight, onPress, onMeasure }: Props) {
  function handleLayout(event: LayoutChangeEvent) {
    onMeasure(event.nativeEvent.layout.height);
  }

  return (
    <Pressable
      accessibilityRole="button"
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
      <Text style={[styles.label, state === 'dimmed' ? styles.labelDimmed : null]}>{label}</Text>
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
    writingDirection: 'rtl',
  },
  labelDimmed: { color: colors.muted },
});

const stateStyles = StyleSheet.create({
  idle: {},
  correct: { borderColor: colors.correct, backgroundColor: colors.correctSurface },
  wrong: { borderColor: colors.wrong, backgroundColor: colors.wrongSurface },
  dimmed: { opacity: 0.45 },
});
