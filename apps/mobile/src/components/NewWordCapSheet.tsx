import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Phase 70 (spec D6). The message over a session's first card when the day's cap held its new
 * words back, in the readiness sheet's look (PracticeMoreSheet). "המשך", a tap outside and
 * Android's back all close it and the session goes on; only "המשך" passes the tick box up, as a
 * tap outside or back saves nothing.
 */
export function NewWordCapSheet({
  visible,
  dayCap,
  onClose,
}: {
  visible: boolean;
  dayCap: number;
  onClose: (stopShowing: boolean) => void;
}) {
  const [stop, setStop] = useState(false);
  const close = (stopShowing: boolean) => {
    onClose(stopShowing);
    setStop(false);
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => close(false)}>
      <View style={styles.dim} testID="cap-notice-sheet">
        <Pressable style={styles.outside} onPress={() => close(false)} accessibilityLabel={strings.capNoticeContinue} />
        <View style={styles.sheet}>
          <View style={styles.grab} />
          <Text style={styles.title}>{strings.capNoticeTitle}</Text>
          <Text style={styles.body}>{strings.capNoticeBody(dayCap)}</Text>
          <Pressable
            accessibilityRole="button"
            testID="cap-notice-continue"
            onPress={() => close(stop)}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{strings.capNoticeContinue}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: stop }}
            // react-native-web does not render accessibilityState: on the web this puts the tick
            // in the DOM (as PracticeMoreSheet's does).
            aria-checked={stop}
            testID="cap-notice-stop"
            onPress={() => setStop(!stop)}
            style={styles.check}
          >
            <View style={[styles.box, stop && styles.boxOn]}>{stop ? <Text style={styles.tick}>✓</Text> : null}</View>
            <Text style={styles.checkLabel}>{strings.capNoticeStop}</Text>
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
  button: { borderRadius: radii.md, paddingVertical: 13, alignItems: 'center', backgroundColor: colors.primary },
  buttonText: { fontSize: fontSizes.md, fontWeight: '700', color: colors.onPrimary },
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 1 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 2, borderColor: colors.tabInactive, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: colors.onPrimary, fontSize: 13, lineHeight: 15, fontWeight: '800' },
  checkLabel: { fontSize: fontSizes.sm, color: colors.text, writingDirection: 'rtl' },
});
