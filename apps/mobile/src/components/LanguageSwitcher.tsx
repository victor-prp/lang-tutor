import type { Enrollment } from '@lang-tutor/core/api';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { availableTargets } from '@/enrollments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, radii, shadows, spacing } from '@/theme';

/**
 * Phase 64 (spec D2). The header's language: a chip with the language being learned and ▾,
 * which opens today's switcher (moved here from home): the other enrollments, then
 * הוספת שפה while there is a language left to add. `open` is the header's, so the list can
 * drop under the whole header row.
 */
export function LanguageChip({ active, open, onToggle }: { active: Enrollment; open: boolean; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      testID="enrollment-switcher"
      onPress={onToggle}
      style={styles.chip}
    >
      <Text style={styles.chipLabel}>{`${strings.languageName(active.target_language)} ▾`}</Text>
    </Pressable>
  );
}

export function LanguageList({ active, onDone }: { active: Enrollment; onDone: () => void }) {
  const { enrollments, switchTo } = useCurrentUser();
  const canAdd = availableTargets(enrollments).length > 0;
  return (
    <View style={styles.list}>
      {enrollments.map((enrollment) => (
        <Pressable
          key={enrollment.id}
          accessibilityRole="button"
          accessibilityState={{ selected: enrollment.id === active.id }}
          testID={`enrollment-option-${enrollment.target_language}`}
          onPress={() => {
            switchTo(enrollment.id);
            onDone();
          }}
          style={[styles.item, enrollment.id === active.id && styles.itemActive]}
        >
          <Text style={styles.itemLabel}>{strings.languageName(enrollment.target_language)}</Text>
        </Pressable>
      ))}
      {canAdd ? (
        <Pressable
          accessibilityRole="button"
          testID="enrollment-add"
          onPress={() => {
            onDone();
            router.push('/enroll');
          }}
          style={styles.item}
        >
          <Text style={styles.addLabel}>{strings.addLanguage}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { paddingVertical: spacing.xs, paddingEnd: spacing.sm },
  chipLabel: { color: colors.text, fontSize: fontSizes.md, fontWeight: '600', writingDirection: 'rtl' },
  list: { backgroundColor: colors.surface, borderRadius: radii.group, overflow: 'hidden', ...shadows.card },
  item: { paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md },
  itemActive: { backgroundColor: colors.primarySurface },
  itemLabel: { color: colors.text, fontSize: fontSizes.md, writingDirection: 'rtl' },
  addLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700', writingDirection: 'rtl' },
});
