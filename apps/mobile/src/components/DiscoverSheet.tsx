import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { cardButton } from '@/components/BandCard';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type SheetButton = { label: string; testID: string; onPress: () => void };

/**
 * Phase 74 (spec D2, D8). Words for me's bottom sheet, in the new-word cap sheet's look: the word
 * again with its meaning when it has one, a bold line, a muted line, then two full-width buttons,
 * the first pale and the second solid. A tap outside and Android's back dismiss it.
 */
export function DiscoverSheet({
  visible,
  word,
  wordDirection = 'ltr',
  meaning,
  title,
  body,
  first,
  second,
  testID,
  onDismiss,
}: {
  visible: boolean;
  word?: string;
  wordDirection?: 'rtl' | 'ltr';
  meaning?: string;
  title: string;
  body: string;
  first: SheetButton;
  second: SheetButton;
  testID?: string;
  onDismiss: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={styles.dim} testID={testID ?? 'discover-sheet'}>
        <Pressable style={styles.outside} onPress={onDismiss} accessibilityLabel={first.label} />
        <View style={styles.sheet}>
          <View style={styles.grab} />
          {word ? (
            <View style={styles.wordBox}>
              <Text style={[styles.word, { writingDirection: wordDirection }]}>{word}</Text>
              {meaning ? <Text style={styles.meaning}>{meaning}</Text> : null}
            </View>
          ) : null}
          <View style={styles.texts}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.body}>{body}</Text>
          </View>
          <Pressable accessibilityRole="button" testID={first.testID} onPress={first.onPress} style={cardButton.pale}>
            <Text style={cardButton.paleLabel}>{first.label}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" testID={second.testID} onPress={second.onPress} style={cardButton.solid}>
            <Text style={cardButton.solidLabel}>{second.label}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(16,24,40,0.45)' },
  outside: { flex: 1 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 26,
    gap: 12,
  },
  grab: { width: 40, height: 5, borderRadius: radii.pill, backgroundColor: '#D0D5DD', alignSelf: 'center', marginTop: -8 },
  wordBox: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  word: { fontSize: fontSizes.xxl, lineHeight: lineHeights.xxl, fontWeight: '800', color: colors.text, textAlign: 'center' },
  meaning: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
  texts: { gap: spacing.xs },
  title: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700', color: colors.text, writingDirection: 'rtl', textAlign: 'center' },
  body: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
});
