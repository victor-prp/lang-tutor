import type { PendingRetry } from '@lang-tutor/core/api';
import { StyleSheet, Text, View } from 'react-native';

import { retryNotice } from '@/feedback';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/** Phase 34 (spec D9). A card held for its second try says the first answer
 *  was right, and what is left to find. */
export function RetryNotice({ retry }: { retry: PendingRetry }) {
  const { right, again } = retryNotice(retry);
  return (
    <View style={styles.notice} testID="retry-notice">
      <Text style={styles.right} testID="retry-right">
        {right}
      </Text>
      <Text style={styles.again} testID="retry-again">
        {again}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { gap: spacing.xs, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.correctSurface },
  right: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.correct, fontWeight: '700', writingDirection: 'rtl' },
  again: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
});
