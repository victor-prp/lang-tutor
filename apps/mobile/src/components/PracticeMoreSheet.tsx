import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Phase 65 (spec D9). The bottom sheet that asks before practising past the day's budget.
 * Only "לתרגל בכל זאת" starts a session; "אחזור מחר" and a tap outside close it. The tick box
 * applies to whichever button is pressed, and is passed up with the choice.
 */
export function PracticeMoreSheet({
  visible,
  onLater,
  onAnyway,
}: {
  visible: boolean;
  onLater: (stopAsking: boolean) => void;
  onAnyway: (stopAsking: boolean) => void;
}) {
  const [stop, setStop] = useState(false);
  const later = () => {
    onLater(stop);
    setStop(false);
  };
  const anyway = () => {
    onAnyway(stop);
    setStop(false);
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={later}>
      <View style={styles.dim} testID="practice-more-sheet">
        <Pressable style={styles.outside} onPress={later} accessibilityLabel={strings.practiceMoreLater} />
        <View style={styles.sheet}>
          <View style={styles.grab} />
          <Text style={styles.title}>{strings.practiceMoreSheetTitle}</Text>
          <Text style={styles.body}>{strings.practiceMoreSheetBody}</Text>
          <Pressable
            accessibilityRole="button"
            testID="practice-more-later"
            onPress={later}
            style={[styles.button, styles.solid]}
          >
            <Text style={[styles.buttonText, styles.solidText]}>{strings.practiceMoreLater}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            testID="practice-more-anyway"
            onPress={anyway}
            style={[styles.button, styles.soft]}
          >
            <Text style={[styles.buttonText, styles.softText]}>{strings.practiceMoreAnyway}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: stop }}
            // react-native-web does not render accessibilityState: on the web this puts the tick
            // in the DOM (as PhotoImportRow's does).
            aria-checked={stop}
            testID="practice-more-stop-asking"
            onPress={() => setStop(!stop)}
            style={styles.check}
          >
            <View style={[styles.box, stop && styles.boxOn]}>
              {stop ? <Text style={styles.tick}>✓</Text> : null}
            </View>
            <Text style={styles.checkLabel}>{strings.practiceMoreStopAsking}</Text>
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
  title: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '800', color: colors.text, writingDirection: 'rtl', textAlign: 'right' },
  body: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl', textAlign: 'right' },
  button: { borderRadius: radii.md, paddingVertical: 13, alignItems: 'center' },
  solid: { backgroundColor: colors.primary },
  soft: { backgroundColor: colors.primarySurface },
  buttonText: { fontSize: fontSizes.md, fontWeight: '700' },
  solidText: { color: colors.onPrimary },
  softText: { color: colors.primary },
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 1 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 2, borderColor: colors.tabInactive, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: colors.onPrimary, fontSize: 13, lineHeight: 15, fontWeight: '800' },
  checkLabel: { fontSize: fontSizes.sm, color: colors.text, writingDirection: 'rtl' },
});
