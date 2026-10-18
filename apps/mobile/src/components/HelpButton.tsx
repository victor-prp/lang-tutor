import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text } from 'react-native';

import { strings } from '@/strings';
import { colors, fontSizes } from '@/theme';

type Props = {
  onPress: () => void;
  /** Nothing left to give, or an answer being checked. */
  disabled: boolean;
  testID: string;
};

/**
 * Phase 63 (spec D1). The one help button, the same on every card that has
 * help: a soft chip, a line bulb before its word, which never changes (R2).
 * It sits at the right edge of the place the learner answers (spec D2).
 */
export function HelpButton({ onPress, disabled, testID }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={strings.help}
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      hitSlop={6}
      // The press event is not the caller's: a session's pressHelp would read it as typed text.
      onPress={() => onPress()}
      style={[styles.chip, disabled && styles.chipOff]}
    >
      <Ionicons name="bulb-outline" size={18} color={disabled ? colors.faint : colors.primary} />
      <Text style={[styles.label, disabled && styles.labelOff]}>{strings.help}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // In the RTL row the bulb, the first child, sits to the right of the word.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.primarySurface,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  chipOff: { backgroundColor: colors.faintSurface },
  label: { fontSize: 15, lineHeight: fontSizes.lg, color: colors.primary, fontWeight: '700', writingDirection: 'rtl' },
  labelOff: { color: colors.faint },
});
