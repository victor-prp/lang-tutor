import type { Grant } from '@lang-tutor/core/api';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { confirm } from '@/confirm';
import { myStudents } from '@/grants';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/** The people this user teaches, and the way to invite another. */
export function StudentsSection() {
  const { grants, endGrant } = useCurrentUser();
  const students = myStudents(grants);
  if (students.length === 0) return null;

  async function onPress(g: Grant) {
    if (g.status === 'accepted') {
      router.push({ pathname: '/students/words', params: { grant: g.id } });
      return;
    }
    const yes = await confirm({
      title: strings.cancelInviteTitle,
      message: strings.cancelInviteMessage(g.owner.display_name),
      confirm: strings.cancelInviteConfirm,
      cancel: strings.cancel,
    });
    if (!yes) return;
    try {
      await endGrant(g.id);
    } catch {
      // The row stays; the next focus re-reads the list.
    }
  }

  return (
    <View testID="students-section" style={styles.section}>
      <Text style={styles.title}>{strings.studentsTitle}</Text>
      {students.map((g) => (
        <Pressable
          key={g.id}
          accessibilityRole="button"
          testID={`student-${g.owner.username}`}
          onPress={() => onPress(g)}
          style={styles.row}
        >
          <Text style={styles.rowLabel}>
            {strings.personAndLanguage(g.owner.display_name, g.enrollment.target_language)}
          </Text>
          {g.status === 'pending' ? (
            <Text style={styles.pending}>{strings.studentPending(g.owner.display_name)}</Text>
          ) : null}
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        testID="invite-student"
        onPress={() => router.push('/students/invite')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.inviteStudent}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  title: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  rowLabel: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  pending: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    color: colors.primary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
});
