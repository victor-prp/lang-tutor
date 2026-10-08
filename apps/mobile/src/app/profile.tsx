import type { Grant } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { confirm } from '@/confirm';
import { myTutors } from '@/grants';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

function Row({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text testID={testID} style={styles.rowValue}>
        {value}
      </Text>
    </View>
  );
}

export default function ProfileScreen() {
  const { user, enrollments, grants, endGrant, signOut } = useCurrentUser();

  if (!user) return <Redirect href="/" />;

  const tutors = myTutors(grants);

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

  async function onSignOut() {
    await signOut();
    router.replace('/sign-in');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.profileTitle}</Text>

      <View style={styles.card}>
        <Row label={strings.profileUsernameLabel} value={user.username} testID="profile-username" />
        <Row label={strings.profileNameLabel} value={user.display_name} testID="profile-name" />
        <Row label={strings.profileAgeLabel} value={String(user.age)} testID="profile-age" />
        <Row
          label={strings.onboardingNativeLabel}
          value={strings.languageName(user.native_language)}
          testID="profile-native"
        />
        <Row
          label={strings.onboardingTargetLabel}
          value={
            enrollments.map((enrollment) => strings.languageName(enrollment.target_language)).join(', ') ||
            strings.noneYet
          }
          testID="profile-target"
        />
      </View>

      {tutors.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{strings.tutorsTitle}</Text>
          {tutors.map((g) => (
            <View key={g.id} testID={`tutor-${g.grantee.username}`} style={styles.row}>
              <Text style={styles.rowLabel}>
                {strings.personAndLanguage(g.grantee.display_name, g.enrollment.target_language)}
              </Text>
              <Pressable
                accessibilityRole="button"
                testID={`tutor-end-${g.grantee.username}`}
                onPress={() => onEndTutor(g)}
                style={styles.inlineButton}
              >
                <Text style={styles.secondaryLabel}>{strings.endTutor}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>{strings.teachingTitle}</Text>
        <Pressable
          accessibilityRole="button"
          testID="profile-invite"
          onPress={() => router.push('/students/invite')}
          style={styles.inlineButton}
        >
          <Text style={styles.secondaryLabel}>{strings.inviteStudent}</Text>
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        testID="sign-out-button"
        onPress={onSignOut}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.signOut}</Text>
      </Pressable>

      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}>
        <Text style={styles.secondaryLabel}>{strings.back}</Text>
      </Pressable>

      <View style={styles.spacer} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  cardTitle: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
    paddingVertical: spacing.sm,
    writingDirection: 'rtl',
  },
  inlineButton: { paddingVertical: spacing.sm, alignItems: 'flex-start' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  rowLabel: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
  rowValue: { fontSize: fontSizes.md, color: colors.text, fontWeight: '700' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  secondary: { paddingVertical: spacing.sm, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  spacer: { flex: 1 },
});
