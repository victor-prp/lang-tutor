import type { Grant } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Group, GroupRow, groupStyles } from '@/components/Group';
import { StudentsSection } from '@/components/StudentsSection';
import { confirm } from '@/confirm';
import { availableTargets } from '@/enrollments';
import { myStudents, myTutors } from '@/grants';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

/**
 * Phase 64 (spec D7). The אני tab, who you are and who you learn with: the profile's fields,
 * the languages (and adding one), the tutors (and ending one), and teaching: the students
 * (home's list, moved here) and inviting one. How the app behaves is הגדרות'.
 */
export default function MeTab() {
  const { user, enrollments, grants, endGrant } = useCurrentUser();
  if (!user) return <Redirect href="/" />;

  const tutors = myTutors(grants);
  // StudentsSection draws the students and its own invite button; with none, the row invites.
  const teaching = myStudents(grants).length > 0;
  const canAdd = availableTargets(enrollments).length > 0;

  async function onEndTutor(g: Grant) {
    const yes = await confirm({
      title: strings.endTutorTitle,
      message: strings.endTutorMessage(g.grantee.display_name),
      confirm: strings.endTutor,
      cancel: strings.cancel,
    });
    if (!yes) return;
    try {
      await endGrant(g.id);
    } catch {
      // The row stays; the next load of the grants re-reads it.
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={[]}>
      <ScrollView contentContainerStyle={styles.content}>

        <View style={styles.who}>
          <View style={styles.avatar}>
            <Text style={styles.initial}>{user.display_name.slice(0, 1)}</Text>
          </View>
          <View style={styles.names}>
            <Text testID="profile-name" style={styles.name}>
              {user.display_name}
            </Text>
            <Text testID="profile-username" style={styles.username}>
              {user.username}
            </Text>
          </View>
        </View>

        <Group>
          <GroupRow label={strings.profileAgeLabel} value={String(user.age)} testID="profile-age" />
        </Group>

        <Group title={strings.myLanguagesTitle}>
          <GroupRow label={strings.onboardingNativeLabel} value={strings.languageName(user.native_language)} testID="profile-native" />
          <GroupRow
            label={strings.onboardingTargetLabel}
            value={
              enrollments.map((enrollment) => strings.languageName(enrollment.target_language)).join(', ') ||
              strings.noneYet
            }
            testID="profile-target"
          />
          {canAdd ? (
            <Pressable
              accessibilityRole="button"
              testID="me-add-language"
              onPress={() => router.push('/enroll')}
              style={groupStyles.row}
            >
              <Text style={groupStyles.link}>{`+ ${strings.addLanguage}`}</Text>
            </Pressable>
          ) : null}
        </Group>

        {tutors.length > 0 ? (
          <Group title={strings.tutorsTitle}>
            {tutors.map((g) => (
              <View key={g.id} testID={`tutor-${g.grantee.username}`} style={groupStyles.row}>
                <Text style={groupStyles.label}>
                  {strings.personAndLanguage(g.grantee.display_name, g.enrollment.target_language)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  testID={`tutor-end-${g.grantee.username}`}
                  onPress={() => onEndTutor(g)}
                >
                  <Text style={groupStyles.link}>{strings.endTutor}</Text>
                </Pressable>
              </View>
            ))}
          </Group>
        ) : null}

        <Group title={strings.teachingTitle}>
          {teaching ? (
            <View style={styles.students}>
              <StudentsSection />
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              testID="profile-invite"
              onPress={() => router.push('/students/invite')}
              style={groupStyles.row}
            >
              <Text style={groupStyles.link}>{`+ ${strings.inviteStudent}`}</Text>
            </Pressable>
          )}
        </Group>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.md },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: { fontSize: fontSizes.lg, fontWeight: '800', color: colors.primary },
  names: { gap: 2 },
  name: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '800', color: colors.text, writingDirection: 'rtl' },
  username: { fontSize: fontSizes.sm, color: colors.muted },
  students: { padding: spacing.md },
});
