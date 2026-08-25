import { StyleSheet, View } from 'react-native';

import { colors, radii } from '@/theme';

export function ProgressBar({ position, total }: { position: number; total: number }) {
  const ratio = total === 0 ? 0 : Math.max(0, Math.min(1, position / total));
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { flex: ratio }]} />
      <View style={{ flex: 1 - ratio }} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    height: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  fill: { backgroundColor: colors.primary, borderRadius: radii.pill },
});
