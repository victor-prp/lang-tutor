import { StyleSheet, Text, View } from 'react-native';

import { pipsFor } from '@/progress';
import { strings } from '@/strings';
import { colors, fontSizes, spacing } from '@/theme';

/** A level as five pips and its name: the one ladder every screen shows (spec §5). */
export function LevelBadge({ level, testID }: { level: number; testID: string }) {
  return (
    <View style={styles.badge} testID={testID} accessibilityLabel={strings.levelName(level)}>
      <View style={styles.pips}>
        {pipsFor(level).map((filled, i) => (
          <View key={i} style={[styles.pip, filled && styles.pipFilled]} />
        ))}
      </View>
      <Text style={styles.name} testID={`${testID}-name`}>
        {strings.levelName(level)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  pips: { flexDirection: 'row', gap: 2 },
  pip: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.primary },
  pipFilled: { backgroundColor: colors.primary },
  name: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
});
