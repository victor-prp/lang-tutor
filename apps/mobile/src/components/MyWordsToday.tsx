import type { MyWordsToday as Today } from '@lang-tutor/core/api';
import { StyleSheet, Text, View } from 'react-native';

import { todayDots, todayLine, todaySpoken, todayTiles } from '@/myWordsToday';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Phase 73 (spec D5). My words' day: the line (goal and minutes, what is left, or praise), a dot
 * per session of the goal, and two tiles, the new words and the words moved up today. Draws
 * nothing when the goal is off and no tile is due. The line and dots are one accessible element
 * read as `todaySpoken`; the dots are drawing only. `testID` is the prefix home and the results
 * screen each give, so a test can tell the two apart.
 */
export function MyWordsToday({ today, testID }: { today: Today; testID: string }) {
  const line = todayLine(today);
  const dots = todayDots(today);
  const tiles = todayTiles(today);
  if (!line && !tiles) return null;
  const met = line?.tone === 'done';
  return (
    <View testID={testID} style={styles.block}>
      {line ? (
        <View testID={`${testID}-goal`} accessible accessibilityLabel={todaySpoken(today)} style={styles.goal}>
          <View style={styles.lineRow}>
            <Text testID={`${testID}-line`} style={[styles.line, met && styles.lineMet]}>
              {line.text}
            </Text>
            {line.side ? (
              <Text testID={`${testID}-side`} style={styles.side}>
                {line.side}
              </Text>
            ) : null}
          </View>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={styles.dots}>
            {dots.map((dot, at) => (
              <View key={at} testID={`${testID}-dot-${dot}`} style={[styles.dot, DOT_STYLES[dot]]} />
            ))}
          </View>
        </View>
      ) : null}
      {tiles ? (
        <View style={styles.tiles}>
          <Tile testID={`${testID}-tile-new`} count={tiles.newWords.count} label={tiles.newWords.label} />
          <Tile testID={`${testID}-tile-up`} count={tiles.movedUp.count} label={tiles.movedUp.label} />
        </View>
      ) : null}
    </View>
  );
}

function Tile({ testID, count, label }: { testID: string; count: number; label: string }) {
  return (
    <View testID={testID} style={styles.tile}>
      <Text style={styles.tileNumber}>{count}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

// The colours of a target's session dots (TargetCard.tsx's DOT_STYLES).
const DOT_STYLES = {
  done: { backgroundColor: colors.progress },
  todo: { backgroundColor: '#EAECF0' },
  bonus: { backgroundColor: colors.primary },
} as const;

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  goal: { gap: spacing.sm },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 },
  line: { flexShrink: 1, fontSize: 15, lineHeight: lineHeights.md, color: '#344054', writingDirection: 'rtl' },
  lineMet: { color: colors.correct, fontWeight: '700' },
  side: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  // Equal flex: with a large goal the dots narrow and never wrap.
  dots: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  dot: { flex: 1, height: 6, borderRadius: 3 },
  tiles: { flexDirection: 'row', gap: spacing.sm },
  tile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md - 2,
    backgroundColor: colors.primarySurface,
  },
  tileNumber: { fontSize: 22, lineHeight: 28, fontWeight: '800', color: colors.primary },
  tileLabel: { fontSize: 11.5, lineHeight: 15, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
});
