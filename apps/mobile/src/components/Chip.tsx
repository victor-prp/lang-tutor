import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, fontSizes, radii, shadows, spacing } from '@/theme';

/**
 * Phase 52 (spec D8), shared since phase 70: one choice among a row of chips, the reminders'
 * days and hours, and the new-word limits.
 */
export function Chip({
  label,
  selected,
  disabled = false,
  testID,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      // react-native-web 0.21 does not render accessibilityState, so on web this
      // is what puts the choice in the DOM (and in a test).
      aria-selected={selected}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipOn, disabled && styles.disabled]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minWidth: 64,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    ...shadows.card,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { color: colors.text, fontSize: fontSizes.md, fontWeight: '700' },
  chipLabelOn: { color: colors.onPrimary },
  disabled: { opacity: 0.5 },
});
