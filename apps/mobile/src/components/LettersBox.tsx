import { StyleSheet, Text, View } from 'react-native';

import { HelpButton } from '@/components/HelpButton';
import { allRevealed, revealed } from '@/typedHelp';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  /** The word help spells out, a step a press. */
  text: string;
  presses: number;
  onPress: () => void;
  /** An answer being checked. */
  busy: boolean;
  /** The button's testID; the letters' is `hintTestID`. */
  testID: string;
  hintTestID: string;
};

/**
 * Phase 63 (spec D4, D6). Where nothing is typed (say the translation, spoken;
 * listen choice), a dashed box like the input holds the letters help gave, in
 * grey with `…` while the word goes on, and the help button at its right edge.
 * Before any press it is empty but for the button.
 */
export function LettersBox({ text, presses, onPress, busy, testID, hintTestID }: Props) {
  const done = allRevealed(text, presses);
  const shown = revealed(text, presses);
  return (
    <View style={styles.box}>
      <HelpButton testID={testID} disabled={busy || done} onPress={onPress} />
      {shown === '' ? (
        <View style={styles.letters} />
      ) : (
        <Text style={styles.letters} testID={hintTestID} numberOfLines={1}>
          {`${shown}${done ? '' : '…'}`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The RTL row's first child, the button, sits at the right edge.
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: 7,
    paddingRight: 7,
    paddingLeft: spacing.md,
    gap: spacing.sm,
  },
  // A target-language word: left to right inside the mirrored screen.
  letters: { flex: 1, fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.faint, writingDirection: 'ltr', textAlign: 'left' },
});
