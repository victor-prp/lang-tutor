import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

export default function RtlSmokeScreen() {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.row}>
        <Text style={styles.marker}>{'1'}</Text>
        <Text style={styles.marker}>{'2'}</Text>
        <Text style={styles.marker}>{'3'}</Text>
      </View>
      <Text style={styles.hebrew}>{strings.homeSubtitle}</Text>
      <Text style={styles.english}>{'How do you do?'}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  row: { flexDirection: 'row', gap: spacing.md },
  marker: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.primary },
  hebrew: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  english: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
});
