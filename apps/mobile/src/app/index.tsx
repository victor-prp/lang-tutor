import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { InvitesSection } from '@/components/InvitesSection';
import { LearningSection } from '@/components/LearningSection';
import { StudentsSection } from '@/components/StudentsSection';
import { needsEnrollScreen } from '@/grants';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function HomeScreen() {
  const { status, user, enrollments, active, grants, reloadGrants, retry } = useCurrentUser();

  // Fresh on every focus: an invitation may have arrived, or been answered.
  useFocusEffect(
    useCallback(() => {
      void reloadGrants();
    }, [reloadGrants]),
  );

  if (status === 'loading')
    return (
      <SafeAreaView style={styles.loading} edges={['top', 'bottom']}>
        <ActivityIndicator testID="start-loading" size="large" color={colors.primary} />
      </SafeAreaView>
    );
  if (status === 'offline')
    return (
      <SafeAreaView style={styles.offline} edges={['top', 'bottom']}>
        <Text style={styles.title}>{strings.offlineTitle}</Text>
        <Pressable
          testID="offline-retry"
          accessibilityRole="button"
          onPress={() => void retry()}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>{strings.offlineRetry}</Text>
        </Pressable>
      </SafeAreaView>
    );
  if (status === 'signed_out') return <Redirect href="/sign-in" />;
  if (status === 'needs_profile' || !user) return <Redirect href="/onboarding" />;
  // No enrollment and no student is a valid state (spec §5): a new profile, or
  // a profile whose enrollment never landed, arrives here.
  // A tutor with students has a home of their own.
  if (needsEnrollScreen(enrollments, grants)) return <Redirect href="/enroll" />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{strings.appTitle}</Text>
        <Text style={styles.subtitle}>{strings.homeSubtitle}</Text>

        <Pressable
          accessibilityRole="button"
          testID="profile-button"
          onPress={() => router.push('/profile')}
          style={styles.profileLink}
        >
          <Text style={styles.profileLinkLabel}>{user.display_name}</Text>
        </Pressable>

        <InvitesSection />

        {active ? <LearningSection active={active} /> : <StartLearning />}

        <StudentsSection />

        {/* Deliberately empty. Streak, points and daily-target widgets land here. */}
        <View style={styles.futureSpace} />
      </ScrollView>
    </SafeAreaView>
  );
}

function StartLearning() {
  return (
    <Pressable
      accessibilityRole="button"
      testID="start-learning"
      onPress={() => router.push('/enroll')}
      style={styles.button}
    >
      <Text style={styles.buttonLabel}>{strings.startLearning}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  offline: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  subtitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
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
  profileLink: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  profileLinkLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  futureSpace: { flex: 1 },
});
