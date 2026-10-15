import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTargets } from '@/hooks/useTargets';
import { strings } from '@/strings';
import { daysLeftLabel, readyLabel, targetTitle } from '@/targets';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Phase 53 (spec D11). Home's targets: each active one, nearest date first, with how
 * soon it is and how many of its words are ready ("an important motivator"), and below
 * them the button that starts a new one. Home reads the list on every focus. Nothing
 * shows until the first read for the active enrollment lands.
 */
export function TargetsSection() {
  const { list } = useTargets();
  if (!list) return null;
  return (
    <View testID="targets-section" style={styles.section}>
      {list.targets.map((target) => (
        <Pressable
          key={target.id}
          accessibilityRole="button"
          testID={`target-row-${target.id}`}
          onPress={() => router.push(`/targets/${target.id}`)}
          style={styles.row}
        >
          <View style={styles.rowTop}>
            <Text style={styles.title}>{targetTitle(target.kind)}</Text>
            <Text style={styles.when}>{daysLeftLabel(target.days_left)}</Text>
          </View>
          <Text style={styles.ready}>{readyLabel(target.ready_count, target.word_count)}</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        testID="target-new"
        onPress={() => router.push('/targets/new')}
        style={styles.newButton}
      >
        <Text style={styles.newLabel}>{strings.targetNew}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.primary,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  title: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  when: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  ready: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.primary, fontWeight: '700', writingDirection: 'rtl' },
  newButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  newLabel: {
    color: colors.primary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
});
